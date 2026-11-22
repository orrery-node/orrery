import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimateInputTokens, IMAGE_INPUT_TOKENS } from '../src/pricing.ts';

const shot = `data:image/png;base64,${'A'.repeat(400_000)}`;

describe('a prompt with an image in it', () => {
  it('counts text as before, at 4 characters a token over what the model reads', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'What changed in this diff?' }] };
    assert.equal(estimateInputTokens(body), Math.ceil(JSON.stringify({ m: body.messages }).length / 4));
  });

  it('counts an inline image as at most 8,192 tokens, not as the length of its base64', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is in this picture?' }, { type: 'image_url', image_url: { url: shot } }] }] };
    const est = estimateInputTokens(body);
    assert.ok(est >= IMAGE_INPUT_TOKENS && est < IMAGE_INPUT_TOKENS + 100, String(est));
    const two = { ...body, messages: [{ ...body.messages[0], content: [...body.messages[0].content, { type: 'image_url', image_url: { url: shot } }] }] };
    assert.ok(estimateInputTokens(two) >= 2 * IMAGE_INPUT_TOKENS && estimateInputTokens(two) < 2 * IMAGE_INPUT_TOKENS + 120);
  });

  it('leaves a small inline file and a long piece of ordinary text counted as text', () => {
    const small = `data:image/png;base64,${'A'.repeat(2_000)}`;
    const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: small } }] }] };
    assert.equal(estimateInputTokens(body), Math.ceil(JSON.stringify({ m: body.messages }).length / 4));
    const essay = { messages: [{ role: 'user', content: 'x'.repeat(400_000) }] };
    assert.ok(estimateInputTokens(essay) > 100_000, 'text is still counted in full');
  });
});
