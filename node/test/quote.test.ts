import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quote, quoteKind, renderQuote } from '../src/quote.ts';
import { sawText } from '../src/router/watched.ts';

const entry = (name: string, address: string, price: { input: number; output: number; cachedInput?: number }, model = 'm') =>
  ({ address, manifest: { name, models: [{ id: model, price }] }, tee: null }) as never;

describe('orrery quote', () => {
  it('quotes a speech model on its text, one token per 4 characters, with no output column', () => {
    const voice = { address: 'v', manifest: { name: 'Voice', models: [{ id: 'kokoro-82m', price: { input: 1_000_000, output: 0 }, kind: 'speech' }] }, tee: null } as never;
    assert.equal(quoteKind([voice], 'kokoro-82m'), 'speech');
    assert.equal(quoteKind([entry('Chat', 'c', { input: 1, output: 1 })], 'm'), 'chat');
    const rows = quote([voice], 'kokoro-82m', 14, 0, 0.8);
    const text = (renderQuote as unknown as (m: string, i: number, o: number, c: number, r: typeof rows, s: undefined, a: { kind: string; chars: number }) => string)('kokoro-82m', 14, 0, 0.8, rows, undefined, { kind: 'speech', chars: 54 });
    assert.equal(text.split('\n')[0], 'kokoro-82m · speech · 54 characters of text, 14 tokens in (one per 4 characters) · listed prices on Solana, before any holder discount');
    assert.match(text, /^Voice {17} +\$1\.00\/M +\$0\.000014 +—$/m);
    assert.match(text, /cheapest: Voice, \$0\.000014 a request/);
  });

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

  it('says what the same request costs with :private, at the cheapest node in an enclave the router verified', () => {
    const rows = quote([entry('Cheap', 'b', { input: 40_000, output: 140_000 }), entry('Vault in the hills', 'v', { input: 100_000, output: 300_000 })], 'm', 10_000, 500, 0.8);
    rows.forEach((r) => { r.enclave = r.name.startsWith('Vault'); });
    const text = renderQuote('m', 10_000, 500, 0.8, rows);
    assert.equal(text.split('\n').at(-1), 'with :private: Vault in the hills runs in an enclave this router verified, $0.001150 a request (2.4× the cheapest).');
    assert.ok(text.includes('Vault in the ·enclave'), 'a long name is cut, never the mark');
    rows.forEach((r) => { r.enclave = r.name === 'Cheap'; });
    assert.equal(renderQuote('m', 10_000, 500, 0.8, rows).split('\n').at(-1), 'Cheap runs in an enclave this router verified, so :private costs the same.');
    rows.forEach((r) => { r.enclave = false; });
    assert.match(renderQuote('m', 10_000, 500, 0.8, rows).split('\n').at(-1)!, /^cheapest: Cheap/);
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

  it('the record says whether the node’s bills stayed within the prices it listed', () => {
    const w = { checks: 4, up: 4, since: 0 };
    const said = (sawText as unknown as (w: unknown, o: unknown, now: number, b?: unknown) => string)(w, null, 3_600_000, { checked: 41, over: 0 });
    assert.equal(said, 'up in 4 of 4 checks this router made over 1 h; every bill was within its listed prices (41 answers in the last 24 h)');
    const over = (sawText as unknown as (w: unknown, o: unknown, now: number, b?: unknown) => string)(w, null, 3_600_000, { checked: 10, over: 2 });
    assert.ok(over.endsWith('billed above its listed prices in 2 of 10 answers in the last 24 h; this router paid no more than those prices'), over);
    assert.equal((sawText as unknown as (w: unknown, o: unknown, now: number, b?: unknown) => string)(w, null, 3_600_000, { checked: 0, over: 0 }), 'up in 4 of 4 checks this router made over 1 h');
  });
});
