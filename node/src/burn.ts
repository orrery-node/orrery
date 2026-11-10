// Burn on every answer: a provider may pledge, in the price list it pins on chain, to spend a share of every USDC it
// redeems on buying the network token and burning it. The settlement program is not involved and still takes nothing;
// the pledge is the provider's own, and anyone can check it: redeemed USDC is on the provider's account, and each burn
// is a token burn signed by the provider's wallet.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
