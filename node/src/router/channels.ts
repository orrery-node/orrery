// The router's side of each payment channel. The wallet signs once to open (and to top up); after that a session
// key on this computer signs a running total after every request, and nothing else is needed per request.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { ACCOUNT, decodeChannel, decodeProvider, ins, pda, programId } from '../chain/program.ts';
import { sendFresh } from '../chain/send.ts';
import { decodeVoucher, encodeVoucher, signVoucher, verifyVoucher } from '../chain/voucher.ts';
import { fetchNode } from '../proxy.ts';
import { signerOf, writePrivate, type Sign } from '../keys.ts';
import { nextUsageHash, ZERO_HASH, type UsageRecord } from '../usage.ts';

export type ChannelState = {
  provider: string;
  channel: string;
  id: string;
  deposit: bigint;
  cumulative: bigint;
  usageHash: Buffer;
  voucher: string | null;
  openedAt: number;
  checkedAt: number;
};

export type Spend = { day: string; units: bigint };

export class Channels {
  private map = new Map<string, ChannelState>();
  private opening = new Map<string, Promise<ChannelState>>();
  private sign: Sign;
  spend: Spend = { day: '', units: 0n };

  constructor(
    private conn: Connection,
    private wallet: Keypair | null,
    readonly session: Keypair,
    private mint: PublicKey,
    private path: string,
    private opts: { deposit: bigint; topUpBelow: bigint; dailyCap: bigint },
  ) {
    this.sign = signerOf(session);
    this.load();
  }

  private load() {
    if (!existsSync(this.path)) return;
    const raw = JSON.parse(readFileSync(this.path, 'utf8'));
    for (const c of raw.channels ?? []) {
      this.map.set(c.provider, { ...c, deposit: BigInt(c.deposit), cumulative: BigInt(c.cumulative), usageHash: Buffer.from(c.usageHash, 'hex'), checkedAt: 0 });
    }
    if (raw.spend) this.spend = { day: raw.spend.day, units: BigInt(raw.spend.units) };
  }

  private save() {
    const channels = [...this.map.values()].map((c) => ({ ...c, deposit: c.deposit.toString(), cumulative: c.cumulative.toString(), usageHash: c.usageHash.toString('hex') }));
    writePrivate(this.path, JSON.stringify({ channels, spend: { day: this.spend.day, units: this.spend.units.toString() } }, null, 1));
  }

  owner(): PublicKey | null {
    return this.wallet?.publicKey ?? null;
  }

  list(): ChannelState[] {
    return [...this.map.values()];
  }

  get(provider: string): ChannelState | undefined {
    return this.map.get(provider);
  }

  remaining(provider: string): bigint {
    const c = this.map.get(provider);
    return c ? c.deposit - c.cumulative : 0n;
  }

  todaySpent(): bigint {
    const day = new Date().toISOString().slice(0, 10);
    if (this.spend.day !== day) this.spend = { day, units: 0n };
    return this.spend.units;
  }

  overBudget(next: bigint): boolean {
    return this.todaySpent() + next > this.opts.dailyCap;
  }

  /** The open channel to `provider`, opening one with the wallet if there is none or the old one is closing. */
  async ensure(provider: string, need: bigint): Promise<ChannelState> {
    const have = this.map.get(provider);
    if (have && Date.now() - have.checkedAt < 5 * 60_000 && have.deposit - have.cumulative >= need) return have;
    if (have) {
      const info = await this.conn.getAccountInfo(new PublicKey(have.channel));
      if (info) {
        const ch = decodeChannel(info.data);
        if (ch.closingAt === 0n) {
          have.deposit = ch.deposit;
          have.checkedAt = Date.now();
          if (have.deposit - have.cumulative < need) await this.topUp(provider, need);
          return have;
        }
      }
      this.map.delete(provider);
    }
    const pending = this.opening.get(provider);
    if (pending) return pending;
    const p = this.recover(provider)
      .catch(() => null)
      .then(async (found) => {
        if (!found) return this.open(provider, need > this.opts.deposit ? need : this.opts.deposit);
        if (found.deposit - found.cumulative < need) await this.topUp(provider, need);
        return found;
      })
      .finally(() => this.opening.delete(provider));
    this.opening.set(provider, p);
    return p;
  }

  /** A router that lost its own record of a channel (a new machine, a wiped home folder, a server that restarted) but
   * still has the session key can pick the channel up where it left off. It looks on chain for an open channel from
   * this wallet to the provider with this session key, asks the node for the latest voucher it holds, and carries on
   * from that voucher only if the signature is its own and the node is owed nothing beyond it. Otherwise it opens a
   * new channel as before. */
  private async recover(provider: string): Promise<ChannelState | null> {
    if (!this.wallet) return null;
    const accounts = await this.conn.getProgramAccounts(programId(), {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Channel).toString('base64'), encoding: 'base64' } },
        { memcmp: { offset: 8, bytes: this.wallet.publicKey.toBase58() } },
        { memcmp: { offset: 40, bytes: provider } },
      ],
    });
    const mine = accounts
      .map((a) => ({ address: a.pubkey, ch: decodeChannel(a.account.data) }))
      .filter((a) => a.ch.closingAt === 0n && a.ch.sessionKey.equals(this.session.publicKey) && a.ch.mint.equals(this.mint))
      .sort((a, b) => Number(b.ch.openedAt - a.ch.openedAt));
    if (!mine.length) return null;
    const info = await this.conn.getAccountInfo(new PublicKey(provider));
    if (!info) return null;
    const endpoint = decodeProvider(info.data).endpoint.replace(/\/$/, '');
    for (const { address, ch } of mine) {
      const r = await fetchNode(`${endpoint}/orrery/channel?address=${address.toBase58()}`, { timeoutMs: 5_000 }).catch(() => null);
      if (!r?.ok) continue;
      const j = (await r.json()) as { voucher: string | null; owed: string };
      const v = j.voucher ? decodeVoucher(j.voucher) : null;
      if (v && !verifyVoucher(this.session.publicKey, address, v)) continue;
      const cumulative = v?.cumulative ?? 0n;
      if (BigInt(j.owed) !== cumulative || cumulative < ch.redeemed || cumulative > ch.deposit) continue;
      const state: ChannelState = {
        provider, channel: address.toBase58(), id: ch.id.toString(), deposit: ch.deposit, cumulative,
        usageHash: v ? Buffer.from(v.usageHash) : ZERO_HASH, voucher: v ? encodeVoucher(v) : null, openedAt: Number(ch.openedAt) * 1000, checkedAt: Date.now(),
      };
      this.map.set(provider, state);
      this.save();
      return state;
    }
    return null;
  }

  private async open(provider: string, deposit: bigint): Promise<ChannelState> {
    if (!this.wallet) throw new Error('no wallet configured: the router needs one to open a channel (orrery router --wallet <keypair.json>)');
    const id = randomBytes(8).readBigUInt64LE();
    const providerKey = new PublicKey(provider);
    const wallet = this.wallet;
    const channel = pda.channel(wallet.publicKey, providerKey, id);
    try {
      await sendFresh(this.conn, () => new Transaction().add(ins.openChannel(wallet.publicKey, providerKey, this.mint, id, deposit, this.session.publicKey)), [wallet]);
    } catch (e) {
      // A transaction can land while its confirmation times out. The channel id is ours alone, so if its account now
      // exists with our session key, it is open; opening another would lock a second deposit.
      const info = await this.conn.getAccountInfo(channel, 'confirmed').catch(() => null);
      if (!info || !decodeChannel(info.data).sessionKey.equals(this.session.publicKey)) throw e;
    }
    const state: ChannelState = {
      provider, channel: channel.toBase58(), id: id.toString(), deposit, cumulative: 0n,
      usageHash: ZERO_HASH, voucher: null, openedAt: Date.now(), checkedAt: Date.now(),
    };
    this.map.set(provider, state);
    this.save();
    return state;
  }

  async topUp(provider: string, atLeast: bigint): Promise<void> {
    const c = this.map.get(provider);
    if (!c || !this.wallet) return;
    const amount = atLeast > this.opts.deposit ? atLeast : this.opts.deposit;
    const wallet = this.wallet;
    await sendFresh(this.conn, () => new Transaction().add(ins.topUp(wallet.publicKey, new PublicKey(c.channel), this.mint, amount)), [wallet]);
    c.deposit += amount;
    this.save();
  }

  /** Pay for one finished request: extend the usage chain, sign the new total, and return the voucher. */
  settle(provider: string, r: UsageRecord): string {
    const c = this.map.get(provider);
    if (!c) throw new Error('no channel');
    c.cumulative += r.cost;
    c.usageHash = nextUsageHash(c.usageHash, r);
    c.voucher = encodeVoucher(signVoucher(this.sign, new PublicKey(c.channel), c.cumulative, c.usageHash));
    this.todaySpent();
    this.spend.units += r.cost;
    this.save();
    if (c.deposit - c.cumulative < this.opts.topUpBelow) void this.topUp(provider, this.opts.deposit).catch(() => undefined);
    return c.voucher;
  }
}
