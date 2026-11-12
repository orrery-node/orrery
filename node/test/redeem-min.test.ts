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
