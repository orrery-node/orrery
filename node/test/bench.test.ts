import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bench, benchKind, median, renderBench } from '../src/bench.ts';

const entry = (name: string, address: string) => ({ address, manifest: { name, models: [{ id: 'm', price: { input: 37_500, output: 140_000 } }] } }) as never;

describe('orrery bench', () => {
  it('takes medians of odd and even samples', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });

  it('pins each ask to one provider, reads the router headers, and puts providers that answered first by first-token time', async () => {
    const seen: string[] = [];
    let clock = 0;
    const fetchFn = async (_url: string, init: { headers: Record<string, string> }) => {
      const who = init.headers['x-orrery-provider'];
      seen.push(who);
      clock += who === 'fast' ? 50 : 120;
      if (who === 'dark') return { ok: false, status: 502, headers: { get: () => null }, json: async () => ({ error: { message: 'all providers failed' } }) };
      return { ok: true, status: 200, headers: { get: (h: string) => (h === 'x-orrery-cost' ? '0.000004' : h === 'x-orrery-ttft-ms' ? (who === 'fast' ? '40' : '90') : null) }, json: async () => ({}) };
    };
    const rows = await bench({ model: 'm', providers: [entry('Slow', 'slow'), entry('Dark', 'dark'), entry('Fast', 'fast')], router: 'http://r', n: 2, fetchFn, now: () => clock });
    assert.deepEqual(rows.map((r) => [r.name, r.answered, r.asked]), [['Fast', 2, 2], ['Slow', 2, 2], ['Dark', 0, 1]]);
    assert.equal(seen.filter((x) => x === 'dark').length, 1);
    const text = renderBench('m', rows);
    assert.match(text, /Fast\s+2\/2\s+40 ms/);
    assert.match(text, /Dark\s+0\/1\s+did not answer: all providers failed/);
    assert.match(text, /spent \$0\.000016 on this bench/);
  });

  it('asks an embedding model (listed on input tokens only) through /v1/embeddings', async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (url: string, init: { body: string }) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, headers: { get: (h: string) => (h === 'x-orrery-cost' ? '0.000001' : h === 'x-orrery-ttft-ms' ? '12' : null) }, json: async () => ({}) };
    };
    const emb = { address: 'e', manifest: { name: 'Emb', models: [{ id: 'bge-m3', price: { input: 20_000, output: 0 } }] } } as never;
    const rows = await bench({ model: 'bge-m3', providers: [emb], router: 'http://r', n: 2, fetchFn, now: () => 0 });
    assert.deepEqual(urls, ['http://r/v1/embeddings', 'http://r/v1/embeddings']);
    assert.ok(Array.isArray(bodies[0].input) && !('messages' in bodies[0]));
    assert.equal(rows[0].answered, 2);
  });

  it('asks a speech model through /v1/audio/speech and takes the audio it answers with, not JSON', async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (url: string, init: { body: string }) => {
      urls.push(url);
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, headers: { get: (h: string) => (h === 'x-orrery-cost' ? '0.000002' : h === 'x-orrery-ttft-ms' ? '30' : null) }, json: async () => { throw new Error('audio is not JSON'); }, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    const tts = { address: 't', manifest: { name: 'Voice', models: [{ id: 'kokoro-82m', price: { input: 1_000_000, output: 0 }, kind: 'speech' }] } } as never;
    const rows = await bench({ model: 'kokoro-82m', providers: [tts], router: 'http://r', n: 2, fetchFn, now: () => 0 });
    assert.deepEqual(urls, ['http://r/v1/audio/speech', 'http://r/v1/audio/speech']);
    assert.equal(typeof bodies[0].input, 'string');
    assert.equal(rows[0].answered, 2);
    assert.equal(rows[0].error, undefined);
  });

  it('goes by the kind a listing says: a reranker gets /v1/rerank, a model that says nothing is read from its prices', () => {
    assert.equal(benchKind({ price: { output: 0 }, kind: 'rerank' }), 'rerank');
    assert.equal(benchKind({ price: { output: 0 }, kind: 'speech' }), 'speech');
    assert.equal(benchKind({ price: { output: 0 }, kind: 'embeddings' }), 'embeddings');
    assert.equal(benchKind({ price: { output: 0 } }), 'embeddings');
    assert.equal(benchKind({ price: { output: 450_000 } }), 'chat');
    assert.equal(benchKind(undefined), 'chat');
  });
});
