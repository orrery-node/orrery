import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freeNote } from '../src/provider/check.ts';

describe('orrery provider check: work listed for free', () => {
  it('names a model that bills nothing for what it does, by its kind', () => {
    assert.equal(freeNote([{ id: 'flux-schnell', kind: 'image', price: { input: 100_000, output: 0 } }]), 'flux-schnell is listed for images with no output price, and an image is billed as output, so every image would be free: an output price of $3 per million is $0.003 an image. Set the price in provider.json, then provider register');
    assert.equal(freeNote([{ id: 'kokoro-82m', kind: 'speech', price: { input: 0, output: 0 } }]), 'kokoro-82m is listed for speech with no input price, and speech is billed on input, so every answer would be free. Set the price in provider.json, then provider register');
    assert.match(freeNote([{ id: 'bge-m3', kind: 'embeddings', price: { input: 0, output: 0 } }]) ?? '', /^bge-m3 is listed for embeddings with no input price/);
    assert.match(freeNote([{ id: 'llama', price: { input: 0, output: 0 } }]) ?? '', /^llama has neither an input nor an output price/);
  });

  it('says nothing when every model bills something, a chat model with only one price included', () => {
    assert.equal(freeNote([{ id: 'llama', price: { input: 0, output: 600_000 } }, { id: 'flux-schnell', kind: 'image', price: { input: 0, output: 3_000_000 } }, { id: 'kokoro-82m', kind: 'speech', price: { input: 1_000_000, output: 0 } }]), null);
  });
});
