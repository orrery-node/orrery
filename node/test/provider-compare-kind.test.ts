import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compare, renderCompare, typicalOf } from '../src/provider/compare.ts';

const listing = (address: string, models: { id: string; price: { input: number; output: number } }[]) => ({ address, manifest: { name: address, models } }) as never;

describe('orrery provider compare, by the kind of work', () => {
  it('compares an image model on one image and a speech model on 1,000 characters, chat as before', () => {
    assert.deepEqual(typicalOf('image'), { inTokens: 13, outTokens: 1_000, per: 'an image' });
    assert.deepEqual(typicalOf('speech'), { inTokens: 250, outTokens: 0, per: 'per 1,000 characters' });
    assert.equal(typicalOf(undefined), null);
    const mine = [
      { id: 'flux-schnell', kind: 'image', price: { input: 100_000, output: 3_000_000 } },
      { id: 'kokoro-82m', kind: 'speech', price: { input: 1_000_000, output: 0 } },
      { id: 'llama', price: { input: 200_000, output: 450_000 } },
    ];
    const net = [listing('other', [{ id: 'flux-schnell', price: { input: 0, output: 2_000_000 } }])];
    const rows = compare(mine, net, null);
    assert.equal(rows[0].myCost, 3_002n);
    assert.equal(rows[0].lowestCost, 2_000n);
    assert.equal(rows[0].per, 'an image');
    assert.equal(rows[1].myCost, 250n);
    assert.equal(rows[1].per, 'per 1,000 characters');
    assert.equal(rows[2].myCost, 625n);
    assert.equal(rows[2].per, undefined);
    const text = renderCompare('N', rows);
    assert.match(text.split('\n')[0], /; an image model on one image, a speech model on 1,000 characters$/);
    assert.match(text, /^flux-schnell .*\$0\.003002 {3}an image: 1 of 1 cheaper/m);
    assert.match(text, /^kokoro-82m .*\$0\.000250 {3}per 1,000 characters: nobody else lists it/m);
  });
});
