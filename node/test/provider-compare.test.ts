import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compare, renderCompare } from '../src/provider/compare.ts';

const entry = (address: string, id: string, input: number, output: number) => ({ address, manifest: { name: address, models: [{ id, price: { input, output } }] } }) as never;

describe('orrery provider compare', () => {
  it('ranks each of my models against the other listings, leaving my own listing out', () => {
    const net = [entry('me', 'm', 1, 1), entry('a', 'm', 100_000, 200_000), entry('b', 'm', 400_000, 800_000), entry('c', 'x', 1, 1)];
    const rows = compare([{ id: 'm', price: { input: 200_000, output: 400_000 } }, { id: 'new', price: { input: 1, output: 1 } }], net, 'me');
    assert.equal(rows[0].others, 2);
    assert.equal(rows[0].cheaper, 1);
    assert.equal(rows[1].others, 0);
    const text = renderCompare('Home', rows);
    assert.match(text, /1 of 2 cheaper; lowest \$0\.10\/M \/ \$0\.20\/M \(\$0\.000300\)/);
    assert.match(text, /nobody else lists it/);
  });

  it('says how far under the next listing the cheapest one is', () => {
    const rows = compare([{ id: 'm', price: { input: 100_000, output: 200_000 } }], [entry('a', 'm', 200_000, 400_000)], null);
    assert.match(renderCompare('Home', rows), /cheapest of 2, \$0\.000300 under the next/);
  });
});
