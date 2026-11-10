// The market buy for a burn pledge on mainnet: USDC from the provider's own wallet into the network token through
// Jupiter, into that same wallet. The wallet signs the swap itself; nothing is held by anyone in between.
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Swapper } from './burn.ts';

const API = 'https://lite-api.jup.ag/swap/v1';

export type JupQuote = { inAmount: string; outAmount: string; priceImpactPct: string; routePlan: unknown[] };
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A quote for spending exactly `usdcUnits`. Refuses a route that moves the price by more than `maxImpact` (a share, 0.05 = 5%). */
export async function jupQuote(usdcMint: string, mint: string, usdcUnits: bigint, o: { slippageBps?: number; maxImpact?: number; fetchFn?: Fetch; api?: string } = {}): Promise<JupQuote> {
  const f = o.fetchFn ?? (fetch as unknown as Fetch);
  const r = await f(`${o.api ?? API}/quote?inputMint=${usdcMint}&outputMint=${mint}&amount=${usdcUnits}&slippageBps=${o.slippageBps ?? 300}`);
  const q = (await r.json()) as JupQuote & { error?: string };
  if (!r.ok || !q.outAmount) throw new Error(`no route to buy the network token: ${q.error ?? r.status}`);
  if (q.inAmount !== usdcUnits.toString()) throw new Error('the quote is for another amount');
  if (Number(q.priceImpactPct) > (o.maxImpact ?? 0.05)) throw new Error(`the buy would move the price by ${(Number(q.priceImpactPct) * 100).toFixed(2)}%, over the limit; it waits for the next redeem`);
  return q;
}

const tokenBalance = async (conn: Connection, ata: PublicKey) => BigInt((await conn.getTokenAccountBalance(ata, 'confirmed').catch(() => null))?.value.amount ?? '0');

/** Buys through Jupiter and reports what actually arrived in the wallet, read back from chain. */
export function jupiterSwapper(conn: Connection, wallet: Keypair, usdcMint: PublicKey, mint: PublicKey, o: { slippageBps?: number; maxImpact?: number; fetchFn?: Fetch; api?: string; tokenProgram?: PublicKey } = {}): Swapper {
  const f = o.fetchFn ?? (fetch as unknown as Fetch);
  return async (usdcUnits) => {
    const quote = await jupQuote(usdcMint.toBase58(), mint.toBase58(), usdcUnits, o);
    const r = await f(`${o.api ?? API}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) });
    const j = (await r.json()) as { swapTransaction?: string; error?: string };
    if (!r.ok || !j.swapTransaction) throw new Error(`the swap could not be built: ${j.error ?? r.status}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'));
    tx.sign([wallet]);
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, o.tokenProgram);
    const before = await tokenBalance(conn, ata);
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const latest = await conn.getLatestBlockhash('confirmed');
    const done = await conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    if (done.value.err) throw new Error(`the swap failed on chain: ${JSON.stringify(done.value.err)}`);
    const got = (await tokenBalance(conn, ata)) - before;
    if (got <= 0n) throw new Error('the swap confirmed but no tokens arrived');
    return { tx: sig, tokens: got };
  };
}
