// Holder pricing. A provider may publish tiers in its manifest: a wallet that holds at least `share` basis points of
// the network token's supply pays `off` basis points less than the list price. The network token is the program's
// bond mint, which the admin sets once on chain, so a tier always means the same token for every provider. Router
// and provider read the same two numbers from chain (the wallet's balance and the mint's supply) and apply the same
// integer formula, so they agree on the price without trusting each other.
import { Connection, PublicKey } from '@solana/web3.js';
import { ATA_PROGRAM, decodeConfig, pda } from './chain/program.ts';
import type { Price } from './pricing.ts';

export type HolderTier = { share: number; off: number };
export type Standing = { mint: string; balance: bigint; supply: bigint };

export const MAX_TIERS = 4;
export const MAX_OFF = 9_000;

/** Tiers must rise together: holding more never gets a smaller discount. */
export function checkTiers(t: unknown): HolderTier[] {
  if (!Array.isArray(t) || t.length === 0 || t.length > MAX_TIERS) throw new Error(`holder tiers: 1 to ${MAX_TIERS} tiers`);
  let prev: HolderTier | null = null;
  for (const x of t as HolderTier[]) {
    if (!Number.isSafeInteger(x?.share) || x.share < 1 || x.share > 10_000) throw new Error('holder tiers: share is basis points of supply, 1 to 10000');
    if (!Number.isSafeInteger(x?.off) || x.off < 1 || x.off > MAX_OFF) throw new Error(`holder tiers: off is basis points of the list price, 1 to ${MAX_OFF}`);
    if (prev && (x.share <= prev.share || x.off <= prev.off)) throw new Error('holder tiers: each tier needs a larger share and a larger discount than the one before');
    prev = x;
  }
  return t as HolderTier[];
}

/** The discount a wallet earns: the best tier whose share of supply it holds, in basis points. */
export function tierOff(tiers: HolderTier[] | undefined, balance: bigint, supply: bigint): number {
  if (!tiers?.length || supply <= 0n || balance <= 0n) return 0;
  let off = 0;
  for (const t of tiers) if (balance * 10_000n >= supply * BigInt(t.share) && t.off > off) off = t.off;
  return off;
}

export function discounted(p: Price, off: number): Price {
  if (!off) return p;
  const keep = 10_000 - off;
  const cut = (n: number) => Math.floor((n * keep) / 10_000);
  return { input: cut(p.input), output: cut(p.output), ...(p.cachedInput === undefined ? {} : { cachedInput: cut(p.cachedInput) }) };
}

/** One of the manifest's own discounts, or 0. Anything else a provider reports is ignored. */
export function knownOff(tiers: HolderTier[] | undefined, off: unknown): number {
  return typeof off === 'number' && tiers?.some((t) => t.off === off) ? off : 0;
}

export function sharePct(s: Standing): string {
  if (s.supply <= 0n) return '0%';
  const pct = Number((s.balance * 1_000_000n) / s.supply) / 10_000;
  return `${pct >= 1 ? pct.toFixed(2) : pct.toFixed(4)}%`;
}

/** Reads the bond mint from the program's Config, the mint's supply and wallets' balances, each cached briefly. A
 * wallet's balance is its associated token account for the mint (the account every wallet and DEX uses), read
 * directly so it works on any RPC, including public ones that refuse token-account scans by mint. */
export class HolderBook {
  private mintAt = 0;
  private mint: PublicKey | null = null;
  private tokenProgram: PublicKey | null = null;
  private supply = { v: 0n, at: 0 };
  private balances = new Map<string, { v: bigint; at: number }>();
  private reading = new Map<string, Promise<void>>();

  /** `serveStale` is for a router: a standing past its minute is answered from memory while a new read runs in the
   * background, so no request waits on the RPC for it. Past ten times that age it is read before answering. A node
   * leaves it off: what it bills is decided on a fresh read. */
  constructor(private conn: Connection, private ttlMs = 60_000, private config = pda.config(), private o: { serveStale?: boolean } = {}) {}

  async bondMint(): Promise<PublicKey | null> {
    if (this.mint || Date.now() - this.mintAt < this.ttlMs) return this.mint;
    this.mintAt = Date.now();
    const info = await this.conn.getAccountInfo(this.config);
    if (!info) return null;
    const m = decodeConfig(info.data).bondMint;
    if (m.equals(PublicKey.default)) return (this.mint = null);
    const mintInfo = await this.conn.getAccountInfo(m);
    if (!mintInfo) return (this.mint = null);
    this.tokenProgram = mintInfo.owner;
    this.mint = m;
    return this.mint;
  }

  async standing(owner: PublicKey, force = false): Promise<Standing | null> {
    const mint = await this.bondMint();
    if (!mint) return null;
    const now = Date.now();
    if (this.o.serveStale) {
      const key = owner.toBase58();
      const have = this.balances.get(key);
      const age = have ? now - Math.min(have.at, this.supply.at) : Infinity;
      if (force || !have || age > this.ttlMs * 10) await this.read(owner, mint);
      else if (age > this.ttlMs) void this.read(owner, mint).catch(() => undefined);
      return { mint: mint.toBase58(), balance: this.balances.get(key)!.v, supply: this.supply.v };
    }
    if (force || now - this.supply.at > this.ttlMs) {
      this.supply = { v: BigInt((await this.conn.getTokenSupply(mint)).value.amount), at: now };
    }
    const key = owner.toBase58();
    let b = this.balances.get(key);
    if (force || !b || now - b.at > this.ttlMs) {
      const ata = PublicKey.findProgramAddressSync([owner.toBuffer(), this.tokenProgram!.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
      const info = await this.conn.getAccountInfo(ata);
      const v = info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;
      b = { v, at: now };
      this.balances.set(key, b);
    }
    return { mint: mint.toBase58(), balance: b.v, supply: this.supply.v };
  }

  /** One read of the supply and one wallet's balance, shared by everyone who asks while it is in flight. */
  private read(owner: PublicKey, mint: PublicKey): Promise<void> {
    const key = owner.toBase58();
    let p = this.reading.get(key);
    if (!p) {
      const ata = PublicKey.findProgramAddressSync([owner.toBuffer(), this.tokenProgram!.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
      p = Promise.all([this.conn.getTokenSupply(mint), this.conn.getAccountInfo(ata)])
        .then(([supply, info]) => {
          const at = Date.now();
          this.supply = { v: BigInt(supply.value.amount), at };
          this.balances.set(key, { v: info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n, at });
        })
        .finally(() => this.reading.delete(key));
      this.reading.set(key, p);
    }
    return p;
  }

  async off(tiers: HolderTier[] | undefined, owner: PublicKey): Promise<number> {
    if (!tiers?.length) return 0;
    try {
      const s = await this.standing(owner);
      return s ? tierOff(tiers, s.balance, s.supply) : 0;
    } catch {
      return 0;
    }
  }
}
