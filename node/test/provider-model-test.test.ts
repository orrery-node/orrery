import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as check from '../src/provider/check.ts';

type Call = { url: string; body: { model: string; max_tokens?: number; input?: string }; auth?: string };
const modelTest = (check as unknown as { modelTest?: (base: string, headers: Record<string, string>, models: { id: string; upstreamModel?: string; price: { input: number; output: number } }[], fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) => Promise<check.CheckLine> }).modelTest;
const M = (id: string, output = 800_000, upstreamModel?: string) => ({ id, upstreamModel, price: { input: 200_000, output } });
const server = (answers: (model: string) => { status: number; body?: string }, calls: Call[] = []) => async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const body = JSON.parse(init.body) as Call['body'];
  calls.push({ url, body, auth: init.headers.authorization });
  const a = answers(body.model);
  return { ok: a.status < 400, status: a.status, text: async () => a.body ?? '{"choices":[{"message":{"content":"ok"}}]}' };
};

describe('orrery provider check asks each listed model one small thing', () => {
  it('asks each model the way its listing says it works: a ranking from a reranker, an embedding from an embedder', async () => {
    const calls: Call[] = [];
    const models = [{ ...M('bge-reranker-v2-m3', 0), kind: 'rerank' }, { ...M('bge-m3', 0), kind: 'embeddings' }, M('e5', 0)];
    const line = await (modelTest as unknown as (b: string, h: Record<string, string>, m: unknown[], f: unknown) => Promise<{ ok: boolean; detail: string }>)('http://h/v1', {}, models, server(() => ({ status: 200 }), calls));
    assert.equal(line.ok, true);
    assert.deepEqual(calls.map((c) => [c.url, c.body.model]), [['http://h/v1/rerank', 'bge-reranker-v2-m3'], ['http://h/v1/embeddings', 'bge-m3'], ['http://h/v1/embeddings', 'e5']]);
    assert.deepEqual((calls[0].body as unknown as { query: string; documents: string[] }).documents, ['ok']);
  });

  it('says each model answered, and how long it took', async () => {
    assert.equal(typeof modelTest, 'function', 'check.ts tests the models');
    const calls: Call[] = [];
    const line = await modelTest!('http://127.0.0.1:11434/v1', { authorization: 'Bearer k' }, [M('llama3.1-8b', 800_000, 'llama3.1:8b'), M('qwen2.5-7b')], server(() => ({ status: 200 }), calls));
    assert.equal(line.ok, true);
    assert.equal(line.what, 'model test');
    assert.match(line.detail, /^llama3\.1:8b answered a test request in \d+ ms; qwen2\.5-7b in \d+ ms$/);
    assert.deepEqual(calls.map((c) => [c.url, c.body.model, c.body.max_tokens, c.auth]), [['http://127.0.0.1:11434/v1/chat/completions', 'llama3.1:8b', 8, 'Bearer k'], ['http://127.0.0.1:11434/v1/chat/completions', 'qwen2.5-7b', 8, 'Bearer k']]);
  });

  it('fails with the model’s name and the server’s reason when one does not answer', async () => {
    const line = await modelTest!('http://h/v1', {}, [M('a'), M('b')], server((m) => (m === 'b' ? { status: 404, body: '{"error":{"message":"model \\"b\\" not found, try pulling it first"}}' } : { status: 200 })));
    assert.equal(line.ok, false);
    assert.match(line.detail, /^b did not answer a test request \(404: model "b" not found, try pulling it first\); a answered in \d+ ms$/);
    const dead = await modelTest!('http://h/v1', {}, [M('a')], async () => { throw new Error('fetch failed'); });
    assert.equal(dead.ok, false);
    assert.match(dead.detail, /^a did not answer a test request \(fetch failed\)$/);
    // A model still loading: said as that, with what to do, and not as a dead model.
    const slow = await modelTest!('http://h/v1', {}, [M('big')], async () => { throw new Error('timeout after 60000ms'); });
    assert.equal(slow.detail, 'big did not answer a test request (no answer in 60 s; a model loading for the first time can take longer, so run the check again)');
  });

  it('tests the first three and says how many it left, and asks an embedding model for an embedding', async () => {
    const calls: Call[] = [];
    const line = await modelTest!('http://h/v1', {}, [M('a'), M('embed-small', 0), M('c'), M('d'), M('e')], server(() => ({ status: 200 }), calls));
    assert.equal(line.ok, true);
    assert.match(line.detail, / \(the first 3 of 5 models\)$/);
    assert.deepEqual(calls.map((c) => c.url.split('/v1')[1]), ['/chat/completions', '/embeddings', '/chat/completions']);
    assert.equal(calls[1].body.input, 'ok');
  });

  it('comes right after the model server in the next step', () => {
    const lines: check.CheckLine[] = [{ what: 'model server', ok: true, detail: '' }, { what: 'model test', ok: false, detail: 'b did not answer a test request (404: not found)' }, { what: 'public address', ok: false, detail: '' }, { what: 'listing', ok: false, detail: 'not on chain yet' }];
    assert.equal(check.nextStep(lines, { config: 'provider.json', publicUrl: 'https://gpu.example.org', nodeKey: 'K' }), 'next: get the model answering: b did not answer a test request (404: not found)');
  });
});
