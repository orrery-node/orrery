import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicStream, anthropicError, toMessage, toOpenAI } from '../src/router/anthropic.ts';

describe('Anthropic Messages on the router', () => {
  it('turns a request with a system prompt, tools and a tool round trip into an OpenAI chat request', () => {
    const out = toOpenAI({
      model: 'llama-3.3-70b:cheap',
      max_tokens: 300,
      stream: true,
      system: [{ type: 'text', text: 'Be brief.' }],
      stop_sequences: ['END'],
      tools: [{ name: 'get_price', description: 'price of a token', input_schema: { type: 'object', properties: { symbol: { type: 'string' } } } }],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'user', content: 'What is SOL at?' },
        { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_price', input: { symbol: 'SOL' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '90.18' }] }, { type: 'text', text: 'And in a sentence?' }] },
      ],
    });
    assert.equal(out.model, 'llama-3.3-70b:cheap');
    assert.equal(out.max_tokens, 300);
    assert.equal(out.stream, true);
    assert.deepEqual(out.stop, ['END']);
    assert.equal(out.tool_choice, 'required');
    assert.deepEqual(out.tools, [{ type: 'function', function: { name: 'get_price', description: 'price of a token', parameters: { type: 'object', properties: { symbol: { type: 'string' } } } } }]);
    assert.deepEqual(out.messages, [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is SOL at?' },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_price', arguments: '{"symbol":"SOL"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: '90.18' },
      { role: 'user', content: 'And in a sentence?' },
    ]);
  });

  it('passes images through as image parts', () => {
    const out = toOpenAI({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what is this?' }] }] });
    assert.deepEqual((out.messages as unknown[])[0], { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'what is this?' }] });
  });

  it('streams text and a tool call as Anthropic events', () => {
    const events: [string, Record<string, unknown>][] = [];
    const s = new AnthropicStream((e, d) => events.push([e, d]), 'msg_abc', 'llama-3.3-70b', 12);
    s.start();
    s.chunk({ choices: [{ index: 0, delta: { content: 'Let me ' } }] });
    s.chunk({ choices: [{ index: 0, delta: { content: 'check.' } }] });
    s.chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_price', arguments: '{"sym' } }] } }] });
    s.chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'bol":"SOL"}' } }] }, finish_reason: 'tool_calls' }] });
    s.finish(14, 9);
    assert.deepEqual(events.map(([e]) => e), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    assert.deepEqual(events[5][1], { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'get_price', input: {} } });
    assert.deepEqual(events[7][1], { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'bol":"SOL"}' } });
    assert.deepEqual(events[9][1], { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 14, output_tokens: 9 } });
  });

  it('assembles a non-streamed message, merging tool call pieces by index', () => {
    const m = toMessage([
      { choices: [{ index: 0, delta: { content: 'Sure.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_price', arguments: '{"symbol":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SOL"}' } }] }, finish_reason: 'tool_calls' }] },
    ], 'msg_1', 'llama-3.3-70b', 20, 7);
    assert.deepEqual(m, {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'llama-3.3-70b',
      content: [{ type: 'text', text: 'Sure.' }, { type: 'tool_use', id: 'call_1', name: 'get_price', input: { symbol: 'SOL' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 7 },
    });
  });

  it('maps a length stop to max_tokens and shapes errors the way Anthropic clients read them', () => {
    const m = toMessage([{ choices: [{ index: 0, delta: { content: 'cut' }, finish_reason: 'length' }] }], 'msg_2', 'm', 1, 1);
    assert.equal(m.stop_reason, 'max_tokens');
    assert.deepEqual(anthropicError(404, 'no provider serves x'), { type: 'error', error: { type: 'not_found_error', message: 'no provider serves x' } });
  });
});
