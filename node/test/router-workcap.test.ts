import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capped, workCap } from '../src/router/workcap.ts';

describe('what a router pays for, for work it can count itself', () => {
  it('pays for no more images than came back, and the prompt at one token per 4 characters', () => {
    const body = { model: 'flux-schnell', prompt: 'a lighthouse made of glass on a night sea', n: 2 };
    const two = workCap('image', body, { data: [{ b64_json: 'x' }, { b64_json: 'y' }] });
    assert.deepEqual(two, { inputTokens: 11, outputTokens: 2_000, images: 2 });
    assert.deepEqual(capped({ inputTokens: 11, outputTokens: 2_000 }, two), { inputTokens: 11, outputTokens: 2_000, over: false });
    const one = workCap('image', body, { data: [{ b64_json: 'x' }] });
    assert.deepEqual(capped({ inputTokens: 11, outputTokens: 2_000 }, one), { inputTokens: 11, outputTokens: 1_000, over: true });
    assert.deepEqual(capped({ inputTokens: 500, outputTokens: 1_000 }, one), { inputTokens: 11, outputTokens: 1_000, over: true });
    const more = workCap('image', body, { data: [{}, {}, {}] });
    assert.equal(more?.outputTokens, 2_000, 'never more images than were asked for');
    assert.equal(workCap('image', body, {})?.outputTokens, 0);
  });

  it('pays for speech by the text the router sent, and leaves chat and embeddings to the bill check it had', () => {
    const say = 'Every answer is paid on Solana, one voucher at a time.';
    const cap = workCap('speech', { model: 'kokoro-82m', input: say }, {});
    assert.deepEqual(cap, { inputTokens: 14, outputTokens: 0 });
    assert.deepEqual(capped({ inputTokens: 40, outputTokens: 0 }, cap), { inputTokens: 14, outputTokens: 0, over: true });
    assert.deepEqual(capped({ inputTokens: 14, outputTokens: 0 }, cap), { inputTokens: 14, outputTokens: 0, over: false });
    assert.equal(workCap('embeddings', { input: 'x' }, {}), null);
    assert.equal(workCap(undefined, {}, {}), null);
    assert.deepEqual(capped({ inputTokens: 9, outputTokens: 3 }, null), { inputTokens: 9, outputTokens: 3, over: false });
  });
});
