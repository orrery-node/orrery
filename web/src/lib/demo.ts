// Server only. The "try it" page runs the real orrery-node router inside the site's server, with a small site
// wallet (DEMO_WALLET_KEY) that pays providers on mainnet. Same code a user runs with `npx orrery-node router`;
// the only differences are a lower deposit and a daily cap of $0.50.
import { mkdirSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

export const DEMO_PORT = 17171;
export const DEMO_MODELS = ['gpt-oss-120b', 'llama-3.3-70b', 'deepseek-v3', 'qwen3-235b'] as const;

type Trip = { at: number; model: string; route: string; provider: string; providerName: string; inputTokens: number; outputTokens: number; cost: string; ttftMs: number; totalMs: number; sealed: boolean; fellThrough: number; off?: number };
type ChannelState = { provider: string; channel: string; deposit: bigint; cumulative: bigint };
export type Demo = {
  router: { trips: Trip[]; close(): Promise<void> };
  channels: { list(): ChannelState[]; todaySpent(): bigint };
  registry: { usable(): unknown[] };
  wallet: string;
};

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
  const [{ Router }, { Channels }, { Registry }, { HolderBook }, { USDC_MAINNET }, { loadOrCreateKeypair }] = await Promise.all([
    import('orrery-node/dist/router/server.js'),
    import('orrery-node/dist/router/channels.js'),
    import('orrery-node/dist/router/registry.js'),
    import('orrery-node/dist/holder.js'),
    import('orrery-node/dist/brand.js'),
    import('orrery-node/dist/keys.js'),
  ]);
  const conn = new Connection(rpc, 'confirmed');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(key)));
  const session = loadOrCreateKeypair(`${home}/router/session.json`);
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
  return { router, channels, registry, wallet: wallet.publicKey.toBase58() };
}
