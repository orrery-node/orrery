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
