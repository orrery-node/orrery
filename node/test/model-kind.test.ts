import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest, kindOf, manifestHash } from '../src/manifest.ts';

const list = (models: Record<string, unknown>[]) => ({ v: 1, name: 'N', authority: 'a', nodeKey: 'k', models: models.map((m) => ({ context: 8192, maxOutput: 1, price: { input: 20_000, output: 0 }, ...m })) });

describe('what a listed model is for', () => {
  it('a listing may say embeddings or rerank, and nothing else', () => {
    assert.doesNotThrow(() => checkManifest(list([{ id: 'bge-reranker-v2-m3', kind: 'rerank' }, { id: 'bge-m3', kind: 'embeddings' }, { id: 'llama-3.3-70b' }])));
    assert.throws(() => checkManifest(list([{ id: 'x', kind: 'chat' }])), /manifest: kind for x, when listed, is embeddings or rerank/);
    assert.throws(() => checkManifest(list([{ id: 'x', kind: 'image' }])), /manifest: kind for x, when listed, is embeddings or rerank/);
  });

  it('a model that says nothing is chat, and a listing without kind keeps the hash it had', () => {
    assert.equal(kindOf({}), 'chat');
    assert.equal(kindOf({ kind: 'rerank' }), 'rerank');
    assert.equal(kindOf({ kind: 'embeddings' }), 'embeddings');
    assert.equal(kindOf({ kind: 'nonsense' }), 'chat');
    const before = list([{ id: 'llama-3.3-70b' }]);
    assert.equal(manifestHash(checkManifest(before)).toString('hex'), manifestHash(checkManifest({ ...before, models: before.models.map((m) => ({ ...m, kind: undefined })) })).toString('hex'));
  });
});
