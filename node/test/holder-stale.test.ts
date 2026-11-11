import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { HolderBook } from '../src/holder.ts';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in RPC: counts reads, answers with whatever balance and supply it holds, and can be held back or broken. */
function rpc() {
  const s = { balance: 5n, supply: 1_000n, reads: 0, gate: null as Promise<void> | null, broken: false };
  const account = () => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(s.balance, 64);
    return { data, owner: TOKEN_PROGRAM };
  };
  const conn = {
    getTokenSupply: async () => {
      s.reads++;
      if (s.gate) await s.gate;
      if (s.broken) throw new Error('rpc down');
      return { value: { amount: s.supply.toString() } };
    },
    getAccountInfo: async () => account(),
  } as unknown as Connection;
  return { s, conn };
}

/** The bond mint is read once from the program's Config; here it is set directly so the test is about the cache. */
function book(conn: Connection, ttlMs: number, serveStale: boolean) {
  const b = new HolderBook(conn, ttlMs, Keypair.generate().publicKey, { serveStale });
  Object.assign(b as unknown as { mint: PublicKey; tokenProgram: PublicKey }, { mint: Keypair.generate().publicKey, tokenProgram: TOKEN_PROGRAM });
  return b;
}

test('a router answers a stale standing from memory and reads again in the background', async () => {
  const { s, conn } = rpc();
  const b = book(conn, 30, true);
  const owner = Keypair.generate().publicKey;
  assert.deepEqual({ ...(await b.standing(owner)), mint: '' }, { mint: '', balance: 5n, supply: 1_000n });
  assert.equal(s.reads, 1);
  await b.standing(owner);
  assert.equal(s.reads, 1, 'within its minute nothing is read');

  await wait(45);
  s.balance = 50n;
  let release!: () => void;
  s.gate = new Promise<void>((r) => (release = r));
  const t0 = performance.now();
  const stale = await b.standing(owner);
  assert.ok(performance.now() - t0 < 20, 'the answer did not wait for the RPC');
  assert.equal(stale!.balance, 5n);
  await b.standing(owner);
  await b.standing(owner);
  assert.equal(s.reads, 2, 'one read is shared while it is in flight');
  release();
  s.gate = null;
  await wait(5);
  assert.equal((await b.standing(owner))!.balance, 50n);
  assert.equal(s.reads, 2);
});

test('a standing far past its age, a first one and a forced one are read before answering', async () => {
  const { s, conn } = rpc();
  const b = book(conn, 5, true);
  const owner = Keypair.generate().publicKey;
  await b.standing(owner);
  s.balance = 9n;
  await wait(70);
  assert.equal((await b.standing(owner))!.balance, 9n, 'older than ten times its age: read first');
  s.balance = 11n;
  assert.equal((await b.standing(owner, true))!.balance, 11n);
  assert.equal(s.reads, 3);
});

test('a background read that fails keeps the last standing and tries again later', async () => {
  const { s, conn } = rpc();
  const b = book(conn, 20, true);
  const owner = Keypair.generate().publicKey;
  await b.standing(owner);
  await wait(30);
  s.broken = true;
  assert.equal((await b.standing(owner))!.balance, 5n);
  await wait(5);
  s.broken = false;
  s.balance = 6n;
  assert.equal((await b.standing(owner))!.balance, 5n, 'still the last good one, with a new read started');
  await wait(5);
  assert.equal((await b.standing(owner))!.balance, 6n);
});

test('a node does not serve a stale standing: past its minute it reads before answering', async () => {
  const { s, conn } = rpc();
  const b = book(conn, 20, false);
  const owner = Keypair.generate().publicKey;
  await b.standing(owner);
  await wait(30);
  s.balance = 77n;
  assert.equal((await b.standing(owner))!.balance, 77n);
});
