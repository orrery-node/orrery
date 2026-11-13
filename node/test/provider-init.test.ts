import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_REPORTING, draftConfig, findUpstream, isEmbeddingModel, networkId } from '../src/provider/init.ts';

const fake = (served: Record<string, string[]>) => async (url: string) => {
  const base = url.replace(/\/models$/, '');
  if (!served[base]) throw new Error('ECONNREFUSED');
  return { ok: true, json: async () => ({ data: served[base].map((id) => ({ id })) }) };
};

describe('orrery provider init', () => {
  it('turns upstream ids into network-style ids', () => {
    assert.equal(networkId('llama3.1:8b'), 'llama3.1-8b');
    assert.equal(networkId('Qwen/Qwen3-32B'), 'qwen3-32b');
    assert.equal(networkId('meta-llama/llama-3.3-70b-instruct'), 'llama-3.3-70b-instruct');
  });

  it('finds the first known local server that lists models, or the one given', async () => {
    const f = await findUpstream(undefined, fake({ 'http://127.0.0.1:8000/v1': ['Qwen/Qwen3-32B'] }));
    assert.deepEqual(f, { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['Qwen/Qwen3-32B'] });
    const g = await findUpstream('http://10.0.0.5:9000/v1/', fake({ 'http://10.0.0.5:9000/v1': ['m1'] }));
    assert.equal(g.baseUrl, 'http://10.0.0.5:9000/v1');
    await assert.rejects(findUpstream(undefined, fake({})), /pass --upstream/);
  });

  it('drafts a config with every model at a placeholder price', () => {
    const c = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b', 'qwen2.5:7b'] }, { name: 'Basement GPU' });
    assert.equal(c.name, 'Basement GPU');
    assert.deepEqual(c.upstream, { baseUrl: 'http://127.0.0.1:11434/v1' });
    assert.deepEqual(c.models.map((m) => [m.id, m.upstreamModel, m.price.input, m.price.output]), [['llama3.1-8b', 'llama3.1:8b', 500_000, 1_000_000], ['qwen2.5-7b', 'qwen2.5:7b', 500_000, 1_000_000]]);
  });

  it('a new node lists payment inside in its price list from its first registration, so routers keep to it from their first request', () => {
    const c = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b'] });
    assert.equal(c.paymentInside, true);
  });

  it('gives a server that reports cache hits a cached-input price, and leaves the others at the input price', () => {
    const v = draftConfig({ name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['Qwen/Qwen3-32B'] });
    assert.equal(v.models[0].price.cachedInput, 125_000);
    const o = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b'] });
    assert.equal('cachedInput' in o.models[0].price, false);
    assert.equal(CACHE_REPORTING.vLLM, '--enable-prompt-tokens-details');
    assert.equal(CACHE_REPORTING.SGLang, '--enable-cache-report');
  });

  it('prices embedding models on input tokens only', () => {
    for (const id of ['BAAI/bge-m3', 'intfloat/e5-large-v2', 'nomic-embed-text', 'mxbai-embed-large', 'text-embedding-3-small', 'Snowflake/snowflake-arctic-embed-l']) assert.ok(isEmbeddingModel(id), id);
    for (const id of ['Qwen/Qwen3-32B', 'llama3.1:8b', 'deepseek-v3', 'gemma-3-27b']) assert.ok(!isEmbeddingModel(id), id);
    const c = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['nomic-embed-text', 'llama3.1:8b'] });
    assert.deepEqual(c.models.map((m) => [m.id, m.price.input, m.price.output]), [['nomic-embed-text', 20_000, 0], ['llama3.1-8b', 500_000, 1_000_000]]);
  });
});
