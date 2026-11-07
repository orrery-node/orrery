import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { costOf } from '../src/pricing.ts';
import { discounted } from '../src/holder.ts';
import { checkManifest } from '../src/manifest.ts';

const seed = { input: 37_500, output: 140_000 };
const cachedSeed = { ...seed, cachedInput: 9_375 };

describe('cached input pricing', () => {
  it('prices cached input tokens at the cached rate and the rest at the input rate', () => {
    assert.equal(costOf(seed, 10_274, 23), 389n);
    assert.equal(costOf(cachedSeed, 10_274, 23, 0), 389n);
    assert.equal(costOf(cachedSeed, 10_274, 23, 10_000), 108n);
  });

  it('ignores reported cache hits when the provider lists no cached price', () => {
    assert.equal(costOf(seed, 10_274, 23, 10_000), costOf(seed, 10_274, 23));
  });

  it('never counts more cached tokens than input tokens, so a cache report can only lower the bill', () => {
    assert.equal(costOf(cachedSeed, 1_000, 10, 50_000), costOf(cachedSeed, 1_000, 10, 1_000));
    assert.ok(costOf(cachedSeed, 1_000, 10, 1_000) <= costOf(cachedSeed, 1_000, 10, 0));
    assert.equal(costOf(cachedSeed, 1_000, 10, -5), costOf(cachedSeed, 1_000, 10, 0));
  });

  it('applies a holder discount to the cached price too', () => {
    assert.deepEqual(discounted(cachedSeed, 2_000), { input: 30_000, output: 112_000, cachedInput: 7_500 });
    assert.deepEqual(discounted(seed, 2_000), { input: 30_000, output: 112_000 });
  });

  it('accepts a cached price at or below the input price and rejects one above it', () => {
    const m = (price: object) => ({ v: 1, name: 'n', models: [{ id: 'gpt-oss-120b', price, context: 131_072, maxOutput: 4_096 }] });
    assert.doesNotThrow(() => checkManifest(m(cachedSeed)));
    assert.doesNotThrow(() => checkManifest(m({ ...seed, cachedInput: 37_500 })));
    assert.throws(() => checkManifest(m({ ...seed, cachedInput: 40_000 })), /cachedInput/);
    assert.throws(() => checkManifest(m({ ...seed, cachedInput: -1 })), /cachedInput/);
  });
});
