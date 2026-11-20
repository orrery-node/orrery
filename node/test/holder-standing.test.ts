import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as holder from '../src/holder.ts';

const h = holder as unknown as { standingLine?: (s: { mint: string; balance: bigint; supply: bigint }, nodes: { name: string; tiers?: { share: number; off: number }[] }[], ticker: string) => string | null };
const tiers = [{ share: 10, off: 2_000 }, { share: 100, off: 3_500 }];
const supply = 1_000_000_000n;
const at = (balance: bigint) => ({ mint: 'M', balance, supply });

describe('where a wallet stands on holder prices', () => {
  it('says the share, the holder price and where, and the nearest step up', () => {
    assert.equal(typeof h.standingLine, 'function', 'holder.ts says where a wallet stands');
    const nodes = [{ name: 'Halo Compute', tiers }, { name: 'Kestrel' }, { name: 'Lantern', tiers }];
    assert.equal(h.standingLine!(at(0n), nodes, 'OREY'), "You hold 0.0000% of $OREY's supply: no holder price yet. 0.1000% more gets you 20% off at Halo Compute and Lantern.");
    assert.equal(h.standingLine!(at(5_000_000n), nodes, 'OREY'), "You hold 0.5000% of $OREY's supply: 20% off at Halo Compute and Lantern. 0.5000% more gets you 35% off at Halo Compute and Lantern.");
    assert.equal(h.standingLine!(at(20_000_000n), nodes, 'OREY'), "You hold 2.00% of $OREY's supply: 35% off at Halo Compute and Lantern. That is the top holder price at every node that lists one.");
  });

  it('says "there" for the one node it already gets a price at, and the smallest step up across nodes', () => {
    assert.equal(h.standingLine!(at(5_000_000n), [{ name: 'Halo Compute', tiers }], 'OREY'), "You hold 0.5000% of $OREY's supply: 20% off at Halo Compute. 0.5000% more gets you 35% off there.");
    const cheapStep = [{ name: 'Halo Compute', tiers }, { name: 'Small Tier Node', tiers: [{ share: 60, off: 2_500 }] }];
    assert.equal(h.standingLine!(at(5_000_000n), cheapStep, 'OREY'), "You hold 0.5000% of $OREY's supply: 20% off at Halo Compute. 0.1000% more gets you 25% off at Small Tier Node.");
    assert.equal(h.standingLine!(at(999_999n), [{ name: 'Halo Compute', tiers }], 'OREY'), "You hold 0.0999% of $OREY's supply: no holder price yet. Under 0.0001% more gets you 20% off at Halo Compute.");
  });

  it('says nothing when no node lists holder prices', () => {
    assert.equal(h.standingLine!(at(5_000_000n), [{ name: 'Kestrel' }], 'OREY'), null);
    assert.equal(h.standingLine!(at(5_000_000n), [], 'OREY'), null);
  });
});
