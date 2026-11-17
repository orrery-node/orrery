import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { roomNote } from '../src/provider/check.ts';

const chat = (id: string, context: number, maxOutput: number) => ({ id, context, maxOutput, price: { input: 500_000, output: 1_000_000 } });

describe('room for the prompt in a listing', () => {
  it('flags a maxOutput as large as the context, and says what to set', () => {
    assert.equal(roomNote([chat('qwen3-32b', 8_192, 8_192)]), 'qwen3-32b lists a maxOutput of 8,192 in a context of 8,192: nothing is left for the prompt, so a request that leaves max_tokens to the node fails at the model server. Set maxOutput to a quarter of context or less (2,048)');
    assert.equal(roomNote([chat('a', 4_096, 8_192), chat('b', 2_048, 2_048)]), 'a (maxOutput 8,192, context 4,096) and b (maxOutput 2,048, context 2,048) list a maxOutput as large as their context: nothing is left for the prompt, so a request that leaves max_tokens to the node fails at the model server. Set maxOutput to a quarter of context or less');
  });

  it('leaves alone a listing with room, an embedding model, and one with no context', () => {
    assert.equal(roomNote([chat('qwen3-32b', 8_192, 2_048), { id: 'bge', context: 512, maxOutput: 1, price: { input: 20_000, output: 0 } }, chat('x', 0, 4_096)]), null);
  });
});
