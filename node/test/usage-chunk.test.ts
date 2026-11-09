import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { billedUsage } from '../src/router/server.ts';

describe('billed usage', () => {
  it('is OpenAI usage with the cost in USDC, the way OpenRouter reports usage.cost', () => {
    assert.deepEqual(billedUsage(91, 102, '0.000018'), { prompt_tokens: 91, completion_tokens: 102, total_tokens: 193, cost: 0.000018 });
  });

  it('keeps a zero-output answer (embeddings) at its input tokens', () => {
    assert.deepEqual(billedUsage(28, 0, '0.000001'), { prompt_tokens: 28, completion_tokens: 0, total_tokens: 28, cost: 0.000001 });
  });
});
