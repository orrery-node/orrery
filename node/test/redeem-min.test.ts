import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDEEM_MIN_UNITS, worthRedeeming } from '../src/provider/node.ts';

test('a node does not spend a transaction fee on dust, and never leaves a closing channel unredeemed', () => {
  const min = BigInt(REDEEM_MIN_UNITS);
  assert.equal(REDEEM_MIN_UNITS, 50_000);
  assert.equal(worthRedeeming(19n, min, false), false, 'nineteen millionths of a dollar waits');
  assert.equal(worthRedeeming(49_999n, min, false), false);
  assert.equal(worthRedeeming(50_000n, min, false), true);
  assert.equal(worthRedeeming(19n, min, true), true, 'the user is closing: redeem whatever is there');
  assert.equal(worthRedeeming(0n, min, true), false);
  assert.equal(worthRedeeming(19n, 1n, false), true, 'an operator who asks for every unit gets it');
});

test('a node never paid out on chain sends its first payout at once, whatever the floor, so its operator sees it land', () => {
  const min = BigInt(REDEEM_MIN_UNITS);
  const worth = worthRedeeming as unknown as (pending: bigint, min: bigint, closing: boolean, firstPayout?: boolean) => boolean;
  assert.equal(worth(21n, min, false, true), true, 'the first answer’s $0.000021 goes out');
  assert.equal(worth(0n, min, false, true), false, 'nothing waiting, nothing sent');
  assert.equal(worth(21n, min, false, false), false, 'after the first payout, the floor applies again');
});
