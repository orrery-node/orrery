import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/mcp.ts';

const models = (data: unknown[]) => (async () => new Response(JSON.stringify({ object: 'list', data }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const row = (id: string, privateProviders: number) => ({ id, object: 'model', providers: 2, private_providers: privateProviders, context_length: 32_768, pricing: { prompt_per_million: 0.2, completion_per_million: 0.6 } });
const call = async (f: typeof fetch) => {
  const r = (await (handle as unknown as (msg: unknown, router: string, f: typeof fetch, v: string) => Promise<{ result?: { content?: { text?: string }[] } } | null>)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'models', arguments: {} } }, 'http://router.test', f, 'test'));
  return r?.result?.content?.[0]?.text ?? '';
};

describe('models through orrery mcp, and :private', () => {
  it('names the enclave count on the line of each model a verified enclave serves, and nothing on the rest', async () => {
    const out = await call(models([row('llama-3.3-70b', 1), row('deepseek-v3', 0)]));
    const [llama, deepseek] = out.split('\n');
    assert.match(llama, /  ·  1 in an enclave this router verified: add :private to send only there/);
    assert.doesNotMatch(deepseek, /enclave/);
    assert.doesNotMatch(out, /:private: no node/);
  });

  it('says once, below the list, when no model can be reached with :private', async () => {
    const out = await call(models([row('llama-3.3-70b', 0), row('deepseek-v3', 0)]));
    assert.match(out, /\n:private: no node serving these runs in an enclave this router verified yet, so a :private ask would be refused\. Without :private, each request still goes sealed to the node's own key\.$/);
  });

  it('says nothing about :private when the network lists no models', async () => {
    assert.equal(await call(models([])), 'no models on the network right now');
  });
});
