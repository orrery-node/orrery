// Burn on every answer: a provider may pledge, in the price list it pins on chain, to spend a share of every USDC it
// redeems on buying the network token and burning it. The settlement program is not involved and still takes nothing;
// the pledge is the provider's own, and anyone can check it: redeemed USDC is on the provider's account, and each burn
// is a token burn signed by the provider's wallet.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { sendFresh } from './chain/send.ts';

/** One buy-and-burn: USDC spent (base units), tokens burned (base units), and the two transactions that prove it. */
export type BurnReceipt = { at: number; usdc: string; burned: string; swapTx: string; burnTx: string };

/** Turns USDC into the network token in the provider's own wallet. Jupiter on mainnet; a local desk in the rehearsal. */
export type Swapper = (usdcUnits: bigint) => Promise<{ tx: string; tokens: bigint }>;
/** Burns tokens from the provider's wallet and returns the transaction. */
export type Burner = (tokens: bigint) => Promise<string>;

export type BurnBook = { spent: bigint; burned: bigint; receipts: BurnReceipt[] };

/** USDC the pledge owes right now: the share of everything redeemed so far, minus what has already been spent. */
export function burnDue(redeemed: bigint, shareBps: number, spent: bigint): bigint {
  const owed = (redeemed * BigInt(shareBps)) / 10_000n;
  return owed > spent ? owed - spent : 0n;
}

/** How much of its pledge a provider has kept, 0 to 1, from numbers a router reads on chain itself. A provider with
 * nothing redeemed has nothing to keep yet. */
export function pledgeKept(redeemed: bigint, shareBps: number, verifiedSpent: bigint): number {
  const owed = (redeemed * BigInt(shareBps)) / 10_000n;
  if (owed <= 0n) return 1;
  return Math.min(1, Number((verifiedSpent * 1_000_000n) / owed) / 1_000_000);
}

export function loadBook(path: string): BurnBook {
  if (!existsSync(path)) return { spent: 0n, burned: 0n, receipts: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { spent: string; burned: string; receipts: BurnReceipt[] };
  return { spent: BigInt(raw.spent), burned: BigInt(raw.burned), receipts: raw.receipts ?? [] };
}

export function saveBook(path: string, b: BurnBook) {
  writeFileSync(path, JSON.stringify({ spent: b.spent.toString(), burned: b.burned.toString(), receipts: b.receipts }, null, 1));
}

/** Buys and burns what the pledge owes, if it is at least `minUnits` (swaps below a few cents are not worth their
 * fee). The book is saved after the swap and again after the burn, so a crash between the two burns the bought tokens
 * on the next run instead of buying twice. */
export async function burnOnce(o: { path: string; redeemed: bigint; shareBps: number; minUnits: bigint; swap: Swapper; burn: Burner; now?: () => number }): Promise<BurnReceipt | null> {
  const book = loadBook(o.path);
  const due = burnDue(o.redeemed, o.shareBps, book.spent);
  if (due < o.minUnits || due === 0n) return null;
  const { tx: swapTx, tokens } = await o.swap(due);
  book.spent += due;
  saveBook(o.path, book);
  const burnTx = await o.burn(tokens);
  const receipt: BurnReceipt = { at: (o.now ?? Date.now)(), usdc: due.toString(), burned: tokens.toString(), swapTx, burnTx };
  book.burned += tokens;
  book.receipts.push(receipt);
  saveBook(o.path, book);
  return receipt;
}

/** A token burn from the wallet's own token account: the supply goes down by exactly that much, on chain. */
export function splBurner(conn: Connection, wallet: Keypair, mint: PublicKey, decimals: number, tokenProgram?: PublicKey): Burner {
  return async (tokens) => {
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram);
    return sendFresh(conn, () => new Transaction().add(createBurnCheckedInstruction(ata, mint, wallet.publicKey, tokens, decimals, [], tokenProgram)), [wallet]);
  };
}

type Bal = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
type ParsedIx = { parsed?: { type?: string; info?: { mint?: string; authority?: string; amount?: string; tokenAmount?: { amount: string } } } };
export type ParsedTx = { meta: { err: unknown; preTokenBalances?: Bal[] | null; postTokenBalances?: Bal[] | null; innerInstructions?: { instructions: ParsedIx[] }[] | null } | null; transaction: { message: { instructions: ParsedIx[] } } } | null;

const held = (list: Bal[] | null | undefined, owner: string, mint: string) => (list ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);

/** Tokens a transaction burned from `owner`'s account of `mint`: 0 unless it succeeded and the wallet itself signed the burn. */
export function burnedIn(tx: ParsedTx, mint: string, owner: string): bigint {
  if (!tx?.meta || tx.meta.err) return 0n;
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions)];
  let n = 0n;
  for (const i of all) {
    const p = i.parsed;
    if ((p?.type === 'burnChecked' || p?.type === 'burn') && p.info?.mint === mint && p.info.authority === owner) n += BigInt(p.info.tokenAmount?.amount ?? p.info.amount ?? '0');
  }
  return n;
}

/** What a buy did to `owner`'s balances: settlement tokens that left and network tokens that arrived. */
export function boughtIn(tx: ParsedTx, usdcMint: string, mint: string, owner: string): { usdc: bigint; tokens: bigint } {
  if (!tx?.meta || tx.meta.err) return { usdc: 0n, tokens: 0n };
  const usdc = held(tx.meta.preTokenBalances, owner, usdcMint) - held(tx.meta.postTokenBalances, owner, usdcMint);
  const tokens = held(tx.meta.postTokenBalances, owner, mint) - held(tx.meta.preTokenBalances, owner, mint);
  return { usdc: usdc > 0n ? usdc : 0n, tokens: tokens > 0n ? tokens : 0n };
}

/** A receipt counts for what the chain shows, never for what it claims: the burn must be the wallet's own burn of the
 * network token, and the spend is the USDC that left the wallet in the buy, as long as the buy brought in at least
 * the tokens that were burned. */
export function verifyReceipt(r: BurnReceipt, swap: ParsedTx, burn: ParsedTx, usdcMint: string, mint: string, owner: string): { usdc: bigint; burned: bigint } {
  const burned = burnedIn(burn, mint, owner);
  const b = boughtIn(swap, usdcMint, mint, owner);
  if (burned === 0n || r.swapTx === r.burnTx || b.tokens < burned) return { usdc: 0n, burned: 0n };
  const claimed = BigInt(r.usdc);
  return { usdc: b.usdc < claimed ? b.usdc : claimed, burned };
}
