import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest } from '../src/manifest.ts';
import * as policy from '../src/router/policy.ts';

const tiers = [{ share: 10, off: 2_000 }, { share: 100, off: 3_500 }];
const model = (holdersOnly?: unknown) => ({ id: 'gemma-3-27b-early', context: 8_192, maxOutput: 1_024, price: { input: 1, output: 1 }, ...(holdersOnly === undefined ? {} : { holdersOnly }) });
const manifest = (models: unknown[], holder?: unknown) => ({ v: 1, name: 'n', authority: 'a', nodeKey: 'k', models, ...(holder ? { holder } : {}) });

describe('holder-first models', () => {
  it('a price list may open a model to holders only, and only next to holder tiers', () => {
    assert.doesNotThrow(() => checkManifest(manifest([model(true)], { tiers })));
    assert.doesNotThrow(() => checkManifest(manifest([model()])));
    assert.throws(() => checkManifest(manifest([model(true)])), /listed for holders only, which needs holder tiers/);
    assert.throws(() => checkManifest(manifest([model(false)], { tiers })), /holdersOnly for gemma-3-27b-early, when listed, is true/);
  });

  it('the router asks a holders-only listing only where its wallet gets the holder price', () => {
    const p = policy as unknown as { openTo?: (o: { entry: { address: string }; offer: { holdersOnly?: true } }[], offOf: (e: { address: string }) => number) => { open: { entry: { address: string } }[]; closed: number } };
    assert.equal(typeof p.openTo, 'function', 'policy.ts filters holder-first listings');
    const offers = [{ entry: { address: 'early' }, offer: { holdersOnly: true as const } }, { entry: { address: 'plain' }, offer: {} }, { entry: { address: 'early-2' }, offer: { holdersOnly: true as const } }];
    const none = p.openTo!(offers, () => 0);
    assert.deepEqual(none.open.map((o) => o.entry.address), ['plain']);
    assert.equal(none.closed, 2);
    const some = p.openTo!(offers, (e) => (e.address === 'early' ? 3_500 : 0));
    assert.deepEqual(some.open.map((o) => o.entry.address), ['early', 'plain']);
    assert.equal(some.closed, 1);
  });
});
