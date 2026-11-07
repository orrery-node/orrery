import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesStream, responsesToChat } from '../src/router/responses.ts';

describe('OpenAI Responses on the router', () => {
  it('turns instructions, input items, a function call round trip and tools into a chat request', () => {
    const out = responsesToChat({
      model: 'llama-3.3-70b', instructions: 'Be brief.', max_output_tokens: 200, stream: true,
      tools: [{ type: 'function', name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
      tool_choice: 'auto',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'List the files.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt b.txt' },
        { role: 'developer', content: 'Answer in one line.' },
      ],
    });
    assert.equal(out.max_tokens, 200);
    assert.equal(out.tool_choice, 'auto');
    assert.deepEqual(out.tools, [{ type: 'function', function: { name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }]);
    assert.deepEqual(out.messages, [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'List the files.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt b.txt' },
      { role: 'system', content: 'Answer in one line.' },
    ]);
    assert.deepEqual(responsesToChat({ model: 'm', input: 'hi' }).messages, [{ role: 'user', content: 'hi' }]);
  });

  it('streams text and a function call as Responses events and ends with the whole response', () => {
    const ev: [string, Record<string, unknown>][] = [];
    const s = new ResponsesStream((e, d) => ev.push([e, d]), 'resp_abc123', 'llama-3.3-70b', 1);
    s.start();
    s.chunk({ choices: [{ index: 0, delta: { content: 'Running ' } }] });
    s.chunk({ choices: [{ index: 0, delta: { content: 'ls.' } }] });
    s.chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'shell', arguments: '{"cmd"' } }] } }] });
    s.chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: 'tool_calls' }] });
    const done = s.finish(12, 7) as { status: string; output: Record<string, unknown>[]; usage: Record<string, number> };
    assert.deepEqual(ev.map(([e]) => e), [
      'response.created', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done',
      'response.completed',
    ]);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.usage, { input_tokens: 12, output_tokens: 7, total_tokens: 19 });
    assert.deepEqual(done.output[0].content, [{ type: 'output_text', text: 'Running ls.', annotations: [] }]);
    assert.equal(done.output[1].type, 'function_call');
    assert.equal(done.output[1].call_id, 'call_9');
    assert.equal(done.output[1].arguments, '{"cmd":"ls"}');
    assert.ok(ev.every(([, d], i) => d.sequence_number === i));
  });
});
