// Server only. The burn, read the way a router reads it: every node that pledged a share of what it redeems, the USDC
// its account says it redeemed, and each buy-and-burn it lists, counted only for what the two transactions show on
// chain. Cached for five minutes.
import { unstable_cache } from 'next/cache';
import { Connection, PublicKey } from '@solana/web3.js';
import { CA } from '@/brand';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type BurnRow = { at: number | null; node: string; usdc: number; burned: number; swapTx: string; burnTx: string };
export type Pledger = { name: string; address: string; share: number; redeemed: number; spent: number; burned: number; kept: number };
export type BurnState = { checked: boolean; at: string; supply: number | null; burned: number; pledgers: Pledger[]; rows: BurnRow[] };

type Entry = { address: string; account: { endpoint: string; authority: PublicKey; settled: bigint }; manifest: { name: string; burn?: { share: number } } | null };
type Bal = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
type Ix = { parsed?: { type?: string; info?: { mint?: string; authority?: string; amount?: string; tokenAmount?: { amount: string } } } };
type Tx = { blockTime?: number | null; meta: { err: unknown; preTokenBalances?: Bal[] | null; postTokenBalances?: Bal[] | null; innerInstructions?: { instructions: Ix[] }[] | null } | null; transaction: { message: { instructions: Ix[] } } } | null;

const held = (l: Bal[] | null | undefined, owner: string, mint: string) => (l ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);

function burnedIn(tx: Tx, mint: string, owner: string): bigint {
  if (!tx?.meta || tx.meta.err) return 0n;
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions)];
  let n = 0n;
  for (const i of all) {
    const p = i.parsed;
    if ((p?.type === 'burnChecked' || p?.type === 'burn') && p.info?.mint === mint && p.info.authority === owner) n += BigInt(p.info.tokenAmount?.amount ?? p.info.amount ?? '0');
  }
  return n;
}

async function read(): Promise<BurnState> {
  const at = new Date().toISOString();
  const url = process.env.SOLANA_RPC_URL;
  const empty: BurnState = { checked: false, at, supply: null, burned: 0, pledgers: [], rows: [] };
  if (!url || !CA) return empty;
  try {
    const conn = new Connection(url, 'confirmed');
    const supply = Number((await conn.getTokenSupply(new PublicKey(CA))).value.uiAmount ?? 0);
    const { Registry } = (await import('orrery-node/dist/router/registry.js')) as unknown as {
      Registry: new (c: Connection, o: { allowDev: boolean; measurements: string[] }) => { refresh(): Promise<void>; usable(): Entry[] };
    };
    const registry = new Registry(conn, { allowDev: false, measurements: [] });
    await registry.refresh();
    const pledgers: Pledger[] = [];
    const rows: BurnRow[] = [];
    const used = new Set<string>();
    for (const e of registry.usable()) {
      const share = e.manifest?.burn?.share;
      if (!share) continue;
      const owner = e.account.authority.toBase58();
      const j = (await fetch(`${e.account.endpoint.replace(/\/$/, '')}/orrery/burns`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { receipts?: { usdc: string; swapTx: string; burnTx: string }[] } | null;
      let spent = 0n, burned = 0n;
      for (const r of (j?.receipts ?? []).slice(-50)) {
        if (typeof r?.swapTx !== 'string' || typeof r.burnTx !== 'string' || r.swapTx === r.burnTx || used.has(r.swapTx) || used.has(r.burnTx)) continue;
        used.add(r.swapTx);
        used.add(r.burnTx);
        const [swap, burn] = (await Promise.all([r.swapTx, r.burnTx].map((s) => conn.getParsedTransaction(s, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)))) as Tx[];
        const b = burnedIn(burn, CA, owner);
        if (!swap?.meta || swap.meta.err || b === 0n) continue;
        const usdcOut = held(swap.meta.preTokenBalances, owner, USDC) - held(swap.meta.postTokenBalances, owner, USDC);
        const got = held(swap.meta.postTokenBalances, owner, CA) - held(swap.meta.preTokenBalances, owner, CA);
        if (got < b || usdcOut <= 0n) continue;
        const claimed = BigInt(r.usdc);
        const u = usdcOut < claimed ? usdcOut : claimed;
        spent += u;
        burned += b;
        rows.push({ at: burn?.blockTime ? burn.blockTime * 1000 : null, node: e.manifest!.name, usdc: Number(u) / 1e6, burned: Number(b) / 1e6, swapTx: r.swapTx, burnTx: r.burnTx });
      }
      const owed = (e.account.settled * BigInt(share)) / 10_000n;
      pledgers.push({ name: e.manifest!.name, address: e.address, share, redeemed: Number(e.account.settled) / 1e6, spent: Number(spent) / 1e6, burned: Number(burned) / 1e6, kept: owed > 0n ? Math.min(1, Number(spent) / Number(owed)) : 1 });
    }
    rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return { checked: true, at, supply, burned: rows.reduce((n, r) => n + r.burned, 0), pledgers, rows };
  } catch {
    return empty;
  }
}

export const burnState = unstable_cache(read, ['burn-v1'], { revalidate: 300 });
