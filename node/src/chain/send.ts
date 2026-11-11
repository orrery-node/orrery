// Sending a transaction through a load-balanced RPC sometimes fails its preflight with no logs: the node that
// simulated it had not seen the blockhash yet. That is not the transaction's fault, so build it again with a fresh
// blockhash and send it again, a few times. Any other error is returned as is.
//
// Every command sends from here. Normally a transaction is confirmed by subscription (a websocket to the RPC); behind
// a proxy there is no websocket (connect.ts), so it is confirmed by asking for its status until it lands or expires.
import { sendAndConfirmTransaction, type Connection, type Signer, type Transaction } from '@solana/web3.js';
import { nodeProxy } from '../proxy.ts';

const TRANSIENT = /blockhash not found|block height exceeded|simulation failed[\s\S]*logs:\s*\[\s*\]|node is behind|429|too many requests/i;

export function isTransient(err: unknown): boolean {
  return TRANSIENT.test((err as Error)?.message ?? String(err));
}

type StatusSource = Pick<Connection, 'getSignatureStatuses' | 'getBlockHeight'>;

/** Asks for a transaction's status until it is confirmed (null), failed (the chain's error) or too old (throws). */
export async function pollStatus(conn: StatusSource, signature: string, lastValidBlockHeight: number, everyMs = 500): Promise<unknown | null> {
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st?.err) return st.err;
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return null;
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`block height exceeded: ${signature} expired before it was confirmed`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Signs, sends and waits by polling: no subscription, so no websocket. */
export async function sendAndPoll(conn: Connection, tx: Transaction, signers: Signer[], everyMs = 500): Promise<string> {
  const latest = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  const failed = await pollStatus(conn, signature, latest.lastValidBlockHeight, everyMs);
  if (failed) throw new Error(`transaction ${signature} failed (${JSON.stringify(failed)})`);
  return signature;
}

/** Sends one transaction and waits for it: by subscription normally, by polling behind a proxy. */
export function sendOne(conn: Connection, tx: Transaction, signers: Signer[]): Promise<string> {
  return nodeProxy() ? sendAndPoll(conn, tx, signers) : sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
}

/** Waits for a transaction that was already sent. Returns the chain's error if it failed, null if it is confirmed. */
export async function confirmed(conn: Connection, signature: string, latest: { blockhash: string; lastValidBlockHeight: number }): Promise<unknown | null> {
  if (nodeProxy()) return pollStatus(conn, signature, latest.lastValidBlockHeight);
  return (await conn.confirmTransaction({ signature, ...latest }, 'confirmed')).value.err;
}

export async function sendFresh(conn: Connection, build: () => Transaction, signers: Signer[], tries = 4): Promise<string> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await sendOne(conn, build(), signers);
    } catch (err) {
      last = err;
      if (!isTransient(err) || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}
