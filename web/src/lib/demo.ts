// Server only. The "try it" page runs the real orrery-node router inside the site's server, with a small site
// wallet (DEMO_WALLET_KEY) that pays providers on mainnet. Same code a user runs with `npx orrery-node router`;
// the only differences are a lower deposit and a daily cap of $0.50.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

export const DEMO_PORT = 17171;
export const DEMO_MODELS = ['gpt-oss-120b', 'llama-3.3-70b', 'deepseek-v3', 'qwen3-235b'] as const;

type Trip = { at: number; model: string; route: string; provider: string; providerName: string; inputTokens: number; outputTokens: number; cost: string; ttftMs: number; totalMs: number; sealed: boolean; fellThrough: number; off?: number };
type ChannelState = { provider: string; channel: string; deposit: bigint; cumulative: bigint };
export type Demo = {
  router: { trips: Trip[]; close(): Promise<void>; stats: { all(): Map<string, { cooldownUntil: number }> } };
  channels: { list(): ChannelState[]; todaySpent(): bigint; ensure(provider: string, need: bigint): Promise<unknown> };
  registry: { usable(): { address: string }[] };
  wallet: string;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens (or checks) a channel to every usable provider before anyone asks, retrying the RPC's transient preflight
 * failures, and lifts the router's cool-down so a provider that only failed on our side is tried again. */
export async function warm(d: Demo): Promise<void> {
  for (const e of d.registry.usable()) {
    for (let i = 0; i < 5; i++) {
      try {
        await d.channels.ensure(e.address, 50_000n);
        const o = d.router.stats.all().get(e.address);
        if (o) o.cooldownUntil = 0;
        break;
      } catch (err) {
        console.log(`[demo] channel to ${e.address.slice(0, 6)} not ready (${(err as Error).message.split('\n')[0]}); retry ${i + 1}`);
        await pause(1500 * (i + 1));
      }
    }
  }
}

/** Channels opened under an older session key can no longer be signed against: ask to close them, then close them
 * once the provider's hour to redeem has passed, and the deposits and account rent come back to the demo wallet. Under
 * this run's session key, the newest open channel to each provider is kept whoever holds it (this run, or the previous
 * instance still finishing during a deploy); only older duplicates are closed. */
async function tidy(d: Demo, conn: Connection, wallet: Keypair, session: PublicKey): Promise<void> {
  const { ACCOUNT, decodeChannel, decodeProvider, ins, programId } = await import('orrery-node/dist/chain/program.js');
  const live = new Set(d.channels.list().map((c) => c.channel));
  const accs = await conn.getProgramAccounts(programId(), {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Channel).toString('base64'), encoding: 'base64' } },
      { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
    ],
  });
  const now = Math.floor(Date.now() / 1000);
  const newest = new Map<string, { key: string; at: bigint }>();
  for (const { pubkey, account } of accs) {
    const c = decodeChannel(account.data);
    if (c.closingAt !== 0n || !c.sessionKey.equals(session)) continue;
    const p = c.provider.toBase58();
    const n = newest.get(p);
    if (!n || c.openedAt > n.at) newest.set(p, { key: pubkey.toBase58(), at: c.openedAt });
  }
  const kept = new Set([...newest.values()].map((n) => n.key));
  for (const { pubkey, account } of accs) {
    if (live.has(pubkey.toBase58()) || kept.has(pubkey.toBase58())) continue;
    const c = decodeChannel(account.data);
    try {
      if (c.closingAt === 0n) {
        await sendAndConfirmTransaction(conn, new Transaction().add(ins.requestClose(wallet.publicKey, pubkey)), [wallet], { commitment: 'confirmed' });
        console.log(`[demo] asked to close ${pubkey.toBase58().slice(0, 6)} from an earlier run`);
      } else if (now >= Number(c.closingAt)) {
        const info = await conn.getAccountInfo(c.provider);
        if (!info) continue;
        const prov = decodeProvider(info.data);
        await sendAndConfirmTransaction(conn, new Transaction().add(ins.closeChannel(wallet.publicKey, prov.authority, pubkey, c.payer, c.mint)), [wallet], { commitment: 'confirmed' });
        console.log(`[demo] closed ${pubkey.toBase58().slice(0, 6)}; its deposit is back in the demo wallet`);
      }
    } catch (e) {
      console.log(`[demo] tidy ${pubkey.toBase58().slice(0, 6)}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

let boot: Promise<Demo | null> | null = null;

export function demo(): Promise<Demo | null> {
  if (!boot) boot = start().catch((e) => {
    console.error(`[demo] router failed to start: ${(e as Error).message}`);
    boot = null;
    return null;
  });
  return boot;
}

async function start(): Promise<Demo | null> {
  const key = process.env.DEMO_WALLET_KEY;
  const rpc = process.env.SOLANA_RPC_URL;
  if (!key || !rpc) return null;
  const home = process.env.ORRERY_HOME ?? '/tmp/orrery-demo';
  process.env.ORRERY_HOME = home;
  mkdirSync(`${home}/router`, { recursive: true });
  const [{ Router }, { Channels }, { Registry }, { HolderBook }, { USDC_MAINNET }] = await Promise.all([
    import('orrery-node/dist/router/server.js'),
    import('orrery-node/dist/router/channels.js'),
    import('orrery-node/dist/router/registry.js'),
    import('orrery-node/dist/holder.js'),
    import('orrery-node/dist/brand.js'),
  ]);
  const conn = new Connection(rpc, 'confirmed');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
  // The session key comes from the wallet key, so every run signs with the same one and can pick up the channel the
  // previous run left open (the router finds it on chain and checks the node's last voucher) instead of opening another.
  const session = Keypair.fromSeed(createHash('sha256').update('orrery-demo-session/1').update(Buffer.from(wallet.secretKey)).digest());
  const channels = new Channels(conn, wallet, session, new PublicKey(USDC_MAINNET), `${home}/router/channels.json`, {
    deposit: 200_000n,
    topUpBelow: 50_000n,
    dailyCap: 500_000n,
  });
  const registry = new Registry(conn, { allowDev: false, measurements: [] });
  const router = new Router({
    port: DEMO_PORT, host: '127.0.0.1', route: 'auto', minReputation: 0, registry, channels, conn, refreshSecs: 300,
    holders: new HolderBook(conn), log: (l: string) => console.log(`[demo] ${l}`),
  });
  await router.start();
  const d = { router, channels, registry, wallet: wallet.publicKey.toBase58() } as unknown as Demo;
  // Clean up before the first request: channels from earlier runs under another session key are closed (their
  // deposits come back after the grace period); an open one under this session key is left for the router to resume.
  sweeper = async () => {
    lastSweep = Date.now();
    await tidy(d, conn, wallet, session.publicKey).catch((e) => console.log(`[demo] tidy: ${(e as Error).message.split('\n')[0]}`));
  };
  await sweeper();
  await warm(d);
  setInterval(() => void sweeper?.(), 15 * 60_000).unref();
  return d;
}

let sweeper: (() => Promise<void>) | null = null;
let lastSweep = 0;

/** The sweep also runs on the back of requests, in case the server's timers were paused between them. */
export function sweepIfDue(): void {
  if (sweeper && Date.now() - lastSweep > 15 * 60_000) void sweeper();
}
