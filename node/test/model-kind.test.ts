import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest, IMAGE_TOKENS, imageCount, kindOf, kindPath, manifestHash, speechTokens } from '../src/manifest.ts';

const list = (models: Record<string, unknown>[]) => ({ v: 1, name: 'N', authority: 'a', nodeKey: 'k', models: models.map((m) => ({ context: 8192, maxOutput: 1, price: { input: 20_000, output: 0 }, ...m })) });

describe('what a listed model is for', () => {
  it('a listing may say embeddings, rerank, speech or image, and nothing else', () => {
    assert.doesNotThrow(() => checkManifest(list([{ id: 'bge-reranker-v2-m3', kind: 'rerank' }, { id: 'bge-m3', kind: 'embeddings' }, { id: 'kokoro-82m', kind: 'speech' }, { id: 'flux-schnell', kind: 'image' }, { id: 'llama-3.3-70b' }])));
    assert.throws(() => checkManifest(list([{ id: 'x', kind: 'chat' }])), /manifest: kind for x, when listed, is embeddings, rerank, speech or image/);
    assert.throws(() => checkManifest(list([{ id: 'x', kind: 'video' }])), /manifest: kind for x, when listed, is embeddings, rerank, speech or image/);
  });

  it('images go to /v1/images/generations, each billed as 1,000 output tokens, 1 to 10 a request', () => {
    assert.equal(kindPath('image'), 'images/generations');
    assert.equal(kindOf({ kind: 'image' }), 'image');
    assert.equal(IMAGE_TOKENS, 1_000);
    assert.equal(imageCount({}), 1);
    assert.equal(imageCount({ n: 4 }), 4);
    assert.equal(imageCount({ n: '2' }), 2);
    assert.equal(imageCount({ n: 11 }), 1);
    assert.equal(imageCount({ n: 0 }), 1);
    assert.equal(imageCount({ n: 2.5 }), 1);
  });

  it('speech goes to /v1/audio/speech and is billed on its text, one input token per 4 characters', () => {
    assert.equal(kindPath('speech'), 'audio/speech');
    assert.equal(kindPath('rerank'), 'rerank');
    assert.equal(kindPath('embeddings'), 'embeddings');
    assert.equal(kindPath('chat'), 'chat/completions');
    assert.equal(kindOf({ kind: 'speech' }), 'speech');
    assert.equal(speechTokens('Every answer is paid on Solana.'), 8);
    assert.equal(speechTokens('abcd'), 1);
    assert.equal(speechTokens('abcde'), 2);
    assert.equal(speechTokens(''), 1);
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
