import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quote, renderQuote } from '../src/quote.ts';

const entry = (name: string, address: string, price: { input: number; output: number; cachedInput?: number }, model = 'm') =>
  ({ address, manifest: { name, models: [{ id: model, price }] }, tee: null }) as never;

describe('orrery quote', () => {
  it('prices one request at every provider of the model, cheapest first, with the cached rate where one is listed', () => {
    const rows = quote([entry('Dear', 'a', { input: 200_000, output: 800_000 }), entry('Cheap', 'b', { input: 40_000, output: 140_000, cachedInput: 10_000 }), entry('Other', 'c', { input: 1, output: 1 }, 'x')], 'm', 10_000, 500, 0.8);
    assert.deepEqual(rows.map((r) => r.name), ['Cheap', 'Dear']);
    assert.equal(rows[0].full, 470n);
    assert.equal(rows[0].cached, 230n);
    assert.equal(rows[1].cached, null);
    const text = renderQuote('m', 10_000, 500, 0.8, rows);
    assert.match(text, /cheapest: Cheap, \$0\.000470 a request, \$0\.47 for a thousand like it/);
    assert.match(text, /Nothing was sent or paid/);
  });

  it('says so when nobody lists the model', () => {
    assert.match(renderQuote('none', 1, 1, 0.8, []), /No provider on the network lists none/);
  });

  it('says under the prices what this router saw of each node it has a record of, and of no other', () => {
    const rows = quote([entry('Dear', 'a', { input: 200_000, output: 800_000 }), entry('Cheap', 'b', { input: 40_000, output: 140_000 })], 'm', 2000, 500, 0.8);
    const saw = (address: string) => (address === 'a' ? 'up in 80 of 82 checks this router made over 3 days; first token in about 960 ms lately' : '');
    const text = (renderQuote as unknown as (m: string, i: number, o: number, c: number, r: typeof rows, s: (a: string) => string) => string)('m', 2000, 500, 0.8, rows, saw);
    const lines = text.split('\n');
    const at = lines.indexOf('what your router saw of them:');
    assert.ok(at > 0, text);
    assert.equal(lines[at + 1], '  Dear  up in 80 of 82 checks this router made over 3 days; first token in about 960 ms lately');
    assert.ok(lines[at + 2].startsWith('cheapest: Cheap'), 'the record sits between the table and the last line, and a node with no record has no line');
    assert.ok(!renderQuote('m', 2000, 500, 0.8, rows).includes('what your router saw'), 'nothing to say without a record');
  });
});
