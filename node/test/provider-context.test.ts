import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { draftConfig, findUpstream, OLLAMA_NOTE } from '../src/provider/init.ts';
import { contextNote } from '../src/provider/check.ts';

// A model server whose /models lists these entries, wherever it is asked.
const serves = (data: Record<string, unknown>[]) => async () => ({ ok: true, json: async () => ({ object: 'list', data }) });

describe('the context a model server says it serves', () => {
  it('provider init lists what the server says it serves (max_model_len) and leaves room for the answer', async () => {
    const f = await findUpstream('http://127.0.0.1:8000/v1', serves([{ id: 'Qwen/Qwen3-32B', max_model_len: 8192 }, { id: 'BAAI/bge-small-en-v1.5', max_model_len: 512 }]));
    assert.deepEqual(draftConfig(f).models.map((m) => [m.id, m.context, m.maxOutput]), [['qwen3-32b', 8192, 2048], ['bge-small-en-v1.5', 512, 1]]);
    const big = await findUpstream('http://127.0.0.1:30000/v1', serves([{ id: 'm', max_model_len: 131072 }]));
    assert.deepEqual(draftConfig(big).models.map((m) => [m.context, m.maxOutput]), [[131072, 4096]]);
  });

  it('keeps the starting numbers when the server does not say', async () => {
    const f = await findUpstream('http://127.0.0.1:1234/v1', serves([{ id: 'llama3.1:8b' }, { id: 'odd', max_model_len: 'lots' }, { id: 'zero', max_model_len: 0 }]));
    assert.deepEqual(f, { name: 'your server', baseUrl: 'http://127.0.0.1:1234/v1', models: ['llama3.1:8b', 'odd', 'zero'] });
    assert.deepEqual(draftConfig(f).models.map((m) => [m.context, m.maxOutput]), [[32768, 4096], [32768, 4096], [32768, 4096]]);
  });

  it('provider check says when provider.json lists more context than the model server serves', () => {
    assert.equal(contextNote([{ id: 'qwen3-32b', upstreamModel: 'Qwen/Qwen3-32B', context: 32768 }], [{ id: 'Qwen/Qwen3-32B', max_model_len: 8192 }]),
      'provider.json lists 32,768 tokens of context for qwen3-32b, but the model server serves 8,192. Longer requests fail there and count against this node: set "context" to 8,192 or less');
    assert.equal(contextNote([{ id: 'a', context: 65536 }, { id: 'b', upstreamModel: 'B', context: 32768 }], [{ id: 'a', max_model_len: 16384 }, { id: 'B', max_model_len: 8192 }]),
      'provider.json lists more context than the model server serves for a (65,536; it serves 16,384) and b (32,768; it serves 8,192). Longer requests fail there and count against this node: set each "context" to what the server serves');
    assert.equal(contextNote([{ id: 'qwen3-32b', upstreamModel: 'Qwen/Qwen3-32B', context: 8192 }], [{ id: 'Qwen/Qwen3-32B', max_model_len: 8192 }]), null);
    assert.equal(contextNote([{ id: 'llama3.1-8b', upstreamModel: 'llama3.1:8b', context: 32768 }], [{ id: 'llama3.1:8b' }]), null);
  });

  it('on Ollama, lists a context Ollama reads whole, since Ollama does not say and drops the rest quietly', async () => {
    const o = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b', 'nomic-embed-text'] });
    assert.deepEqual(o.models.map((m) => [m.id, m.context, m.maxOutput]), [['llama3.1-8b', 4096, 1024], ['nomic-embed-text', 8192, 1]]);
    assert.equal(OLLAMA_NOTE, 'Ollama reads only as much of a prompt as its own context setting allows (OLLAMA_CONTEXT_LENGTH when it starts) and drops the rest without an error, so provider.json lists 4,096 tokens to stay within it. Start Ollama with more and raise "context" to match, with "maxOutput" at a quarter of it');
    // Behind --upstream, Ollama is known by its answer (owned_by is the model's namespace) or by its port.
    assert.equal((await findUpstream('http://10.0.0.7:8080/v1', serves([{ id: 'llama3.1:8b', object: 'model', owned_by: 'library' }]))).name, 'Ollama');
    assert.equal((await findUpstream('http://gpu-box:11434/v1', serves([{ id: 'my/model' }]))).name, 'Ollama');
    assert.equal((await findUpstream('http://10.0.0.7:8000/v1', serves([{ id: 'Qwen/Qwen3-32B', owned_by: 'vllm' }]))).name, 'your server');
  });
});
