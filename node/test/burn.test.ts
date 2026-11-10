import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { burnDue, burnOnce, loadBook, pledgeKept, verifyReceipt, type ParsedTx } from '../src/burn.ts';
import { checkManifest } from '../src/manifest.ts';

const base = { v: 1, name: 'n', authority: 'a', nodeKey: 'k', models: [{ id: 'm', context: 8000, maxOutput: 1000, price: { input: 1, output: 1 } }] };

describe('burn on every answer', () => {
  it('a price list can pledge a share of what the node redeems, 1 to 10000 basis points', () => {
    assert.equal(checkManifest({ ...base, burn: { share: 1000 } }).burn?.share, 1000);
    assert.throws(() => checkManifest({ ...base, burn: { share: 0 } }), /burn\.share/);
    assert.throws(() => checkManifest({ ...base, burn: { share: 10_001 } }), /burn\.share/);
  });

  it('owes the share of everything redeemed, minus what was already spent', () => {
    assert.equal(burnDue(1_000_000n, 1000, 0n), 100_000n);
    assert.equal(burnDue(1_000_000n, 1000, 60_000n), 40_000n);
    assert.equal(burnDue(1_000_000n, 1000, 100_000n), 0n);
    assert.equal(burnDue(1_000_000n, 10_000, 0n), 1_000_000n);
  });

  it('scores a pledge by burns a router verified itself', () => {
    assert.equal(pledgeKept(0n, 1000, 0n), 1);
    assert.equal(pledgeKept(1_000_000n, 1000, 50_000n), 0.5);
    assert.equal(pledgeKept(1_000_000n, 1000, 500_000n), 1);
  });

  it('buys and burns what is due, keeps a receipt, and does nothing below the minimum or when nothing is due', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-burn-')), 'burns.json');
    const calls: string[] = [];
    const swap = async (u: bigint) => { calls.push(`swap ${u}`); return { tx: 'S1', tokens: u * 40n }; };
    const burn = async (t: bigint) => { calls.push(`burn ${t}`); return 'B1'; };
    assert.equal(await burnOnce({ path, redeemed: 50_000n, shareBps: 1000, minUnits: 10_000n, swap, burn }), null);
    const r = await burnOnce({ path, redeemed: 400_000n, shareBps: 1000, minUnits: 10_000n, swap, burn, now: () => 7 });
    assert.deepEqual(r, { at: 7, usdc: '40000', burned: '1600000', swapTx: 'S1', burnTx: 'B1' });
    assert.deepEqual(calls, ['swap 40000', 'burn 1600000']);
    assert.equal(await burnOnce({ path, redeemed: 400_000n, shareBps: 1000, minUnits: 10_000n, swap, burn }), null);
    const book = loadBook(path);
    assert.equal(book.spent, 40_000n);
    assert.equal(book.burned, 1_600_000n);
    assert.equal(book.receipts.length, 1);
  });

  it('a router counts a receipt only for what the chain shows', () => {
    const W = 'WALLET', U = 'USDC', T = 'TOKEN';
    const bal = (mint: string, amount: string, owner = W) => ({ mint, owner, uiTokenAmount: { amount } });
    const swap: ParsedTx = { meta: { err: null, preTokenBalances: [bal(U, '1000'), bal(T, '0')], postTokenBalances: [bal(U, '895'), bal(T, '262500')] }, transaction: { message: { instructions: [] } } };
    const burnOf = (authority: string, mint = T, amount = '262500'): ParsedTx => ({ meta: { err: null }, transaction: { message: { instructions: [{ parsed: { type: 'burnChecked', info: { mint, authority, tokenAmount: { amount } } } }] } } });
    const r = { at: 1, usdc: '105', burned: '262500', swapTx: 'S', burnTx: 'B' };
    assert.deepEqual(verifyReceipt(r, swap, burnOf(W), U, T, W), { usdc: 105n, burned: 262500n });
    assert.deepEqual(verifyReceipt({ ...r, usdc: '9999' }, swap, burnOf(W), U, T, W), { usdc: 105n, burned: 262500n });
    assert.deepEqual(verifyReceipt(r, swap, burnOf('SOMEONE_ELSE'), U, T, W), { usdc: 0n, burned: 0n });
    assert.deepEqual(verifyReceipt(r, swap, burnOf(W, 'OTHER_MINT'), U, T, W), { usdc: 0n, burned: 0n });
    assert.deepEqual(verifyReceipt(r, swap, burnOf(W, T, '999999999'), U, T, W), { usdc: 0n, burned: 0n });
    assert.deepEqual(verifyReceipt(r, { ...swap!, meta: { ...swap!.meta!, err: {} } }, burnOf(W), U, T, W), { usdc: 0n, burned: 0n });
    assert.deepEqual(verifyReceipt(r, swap, null, U, T, W), { usdc: 0n, burned: 0n });
  });
});

import { burnScore, burning, rank, Stats } from '../src/router/policy.ts';
import type { ProviderEntry } from '../src/router/registry.ts';

describe('routing to nodes that burn', () => {
  const entry = (address: string, share: number | null, kept: number | null, price: number): { entry: ProviderEntry; offer: { id: string; context: number; maxOutput: number; price: { input: number; output: number } } } => {
    const offer = { id: 'm', context: 8000, maxOutput: 1000, price: { input: price, output: price } };
    const e = { address, account: { settled: 0n, redeems: 0n, registeredAt: BigInt(Math.floor(Date.now() / 1000)), bonded: 0n }, manifest: { models: [offer], ...(share ? { burn: { share } } : {}) }, problem: null, tee: null, ...(share && kept !== null ? { burn: { share, spent: 0n, burned: 0n, receipts: 1, kept, checkedAt: 0 } } : {}) } as unknown as ProviderEntry;
    return { entry: e, offer };
  };
  it('scores a verified pledge by how much was kept and how large it is, and nothing unverified', () => {
    assert.equal(burnScore(entry('a', 10_000, 1, 1).entry), 1);
    assert.equal(burnScore(entry('b', 2_500, 1, 1).entry), 0.5);
    assert.equal(burnScore(entry('c', 10_000, null, 1).entry), 0);
    assert.equal(burning(entry('d', 10_000, 0.5, 1).entry), false);
  });
  it(':burn keeps only verified burners, largest pledge first; other routes keep everyone', () => {
    const offers = [entry('cheap', null, null, 1), entry('quarter', 2_500, 1, 3), entry('all', 10_000, 1, 5), entry('claims', 10_000, null, 2)];
    assert.deepEqual(rank(offers, 'burn', 100, 100, new Stats()).map((c) => c.entry.address), ['all', 'quarter']);
    assert.equal(rank(offers, 'price', 100, 100, new Stats()).length, 4);
  });
});
