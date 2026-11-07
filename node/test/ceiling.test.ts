import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCeiling, underCeiling } from '../src/router/policy.ts';
import { discounted } from '../src/holder.ts';

describe('price ceiling', () => {
  it('reads dollars per million tokens, input/output', () => {
    assert.deepEqual(parseCeiling('0.50/1.50'), { input: 500_000, output: 1_500_000 });
    assert.deepEqual(parseCeiling(' $0.0375 / $0.14 '), { input: 37_500, output: 140_000 });
    assert.equal(parseCeiling(undefined), undefined);
    assert.equal(parseCeiling(''), undefined);
  });

  it('rejects anything that is not input/output', () => {
    assert.throws(() => parseCeiling('0.5'), /0\.50\/1\.50/);
    assert.throws(() => parseCeiling('cheap/fast'), /0\.50\/1\.50/);
  });

  it('lets through only listings at or under both prices', () => {
    const c = parseCeiling('0.20/0.80');
    assert.ok(underCeiling({ input: 200_000, output: 800_000 }, c));
    assert.ok(!underCeiling({ input: 200_001, output: 100_000 }, c));
    assert.ok(!underCeiling({ input: 100_000, output: 900_000 }, c));
    assert.ok(underCeiling({ input: 9_999_999, output: 9_999_999 }, undefined));
  });

  it('compares the price after a holder discount', () => {
    const c = parseCeiling('0.15/0.60');
    assert.ok(!underCeiling({ input: 200_000, output: 800_000 }, c));
    assert.ok(underCeiling(discounted({ input: 200_000, output: 800_000 }, 3_500), c));
  });
});
