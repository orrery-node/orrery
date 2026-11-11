import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reprice } from '../src/provider/reprice.ts';
import type { ProviderEntry } from '../src/router/registry.ts';

const node = (address: string, name: string, models: Record<string, [number, number]>) => ({ address, manifest: { name, models: Object.entries(models).map(([id, [input, output]]) => ({ id, price: { input, output } })) } }) as unknown as ProviderEntry;
const net = [node('SEED', 'Orrery Seed', { 'gpt-oss-120b': [37_000, 140_000], 'llama-3.3-70b': [890_000, 1_190_000] }), node('ME', 'Mine', { 'gpt-oss-120b': [1, 1] })];

describe('orrery provider price', () => {
  it('undercuts the cheapest other listing by the chosen margin, and scales the cached price with it', () => {
    const [r] = reprice([{ id: 'gpt-oss-120b', price: { input: 500_000, output: 1_000_000, cachedInput: 125_000 } }], net, 'ME', { beatPct: 5 });
    assert.deepEqual(r.to, { input: 35_150, output: 133_000, cachedInput: 8_787 });
    assert.equal(r.changed, true);
    assert.match(r.note, /5% under Orrery Seed/);
  });
  it('never raises a price, and leaves a model nobody else lists alone', () => {
    const rows = reprice([{ id: 'gpt-oss-120b', price: { input: 10_000, output: 40_000 } }, { id: 'qwen3-coder', price: { input: 300_000, output: 900_000 } }], net, 'ME', { beatPct: 5 });
    assert.equal(rows[0].changed, false);
    assert.match(rows[0].note, /already cheapest/);
    assert.equal(rows[1].changed, false);
    assert.match(rows[1].note, /nobody else lists it/);
  });
  it('stops at your floor', () => {
    const [down] = reprice([{ id: 'llama-3.3-70b', price: { input: 2_000_000, output: 3_000_000 } }], net, 'ME', { beatPct: 50, floor: { input: 600_000, output: 900_000 } });
    assert.deepEqual(down.to, { input: 600_000, output: 900_000 });
    assert.match(down.note, /held at your floor/);
    const [stuck] = reprice([{ id: 'gpt-oss-120b', price: { input: 100_000, output: 300_000 } }], net, 'ME', { beatPct: 5, floor: { input: 100_000, output: 300_000 } });
    assert.equal(stuck.changed, false);
    assert.match(stuck.note, /your floor keeps you above Orrery Seed/);
  });
});
