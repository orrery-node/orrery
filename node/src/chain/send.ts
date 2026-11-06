// Sending a transaction through a load-balanced RPC sometimes fails its preflight with no logs: the node that
// simulated it had not seen the blockhash yet. That is not the transaction's fault, so build it again with a fresh
// blockhash and send it again, a few times. Any other error is returned as is.
import { sendAndConfirmTransaction, type Connection, type Signer, type Transaction } from '@solana/web3.js';

const TRANSIENT = /blockhash not found|block height exceeded|simulation failed[\s\S]*logs:\s*\[\s*\]|node is behind|429|too many requests/i;

export function isTransient(err: unknown): boolean {
  return TRANSIENT.test((err as Error)?.message ?? String(err));
}

export async function sendFresh(conn: Connection, build: () => Transaction, signers: Signer[], tries = 4): Promise<string> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await sendAndConfirmTransaction(conn, build(), signers, { commitment: 'confirmed' });
    } catch (err) {
      last = err;
      if (!isTransient(err) || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}
