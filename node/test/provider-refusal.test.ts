import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendRefused, readRefused, refusal, refusedCounts, refusedText } from '../src/provider/refusal.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const offer = { id: 'qwen3-32b', upstreamModel: 'Qwen/Qwen3-32B', context: 32_768 };
const vllm = JSON.stringify({ object: 'error', message: "This model's maximum context length is 8192 tokens. However, you requested 12000 tokens (11936 in the messages, 64 in the completion). Please reduce the length of the messages or completion.", type: 'BadRequestError', param: null, code: 400 });

describe('what a node says when its model server turns a request away', () => {
  it('a prompt longer than the server serves: a 400 the router does not wait out, and a log line that says what to change', () => {
    const r = refusal(400, vllm, offer);
    assert.equal(r.status, 400);
    assert.equal(r.code, 'context_length_exceeded');
    assert.equal(r.log, 'the model server refused a qwen3-32b request as longer than it serves (400); provider.json lists 32,768 tokens of context for it: set "context" to what the server serves (orrery provider check compares them)');
  });

  it('never repeats what the server said, which can quote the request', () => {
    const r = refusal(400, JSON.stringify({ error: { message: 'bad input near "my secret prompt"' } }), offer);
    assert.equal(r.log.includes('secret'), false);
    assert.equal(r.message.includes('secret'), false);
    assert.equal(r.log, 'the model server answered 400 to a qwen3-32b request');
    assert.equal(r.status, 502);
  });

  it('names the usual setup mistakes', () => {
    assert.equal(refusal(404, '{"error":{"message":"model \'Qwen/Qwen3-32B\' not found"}}', offer).log, 'the model server does not know Qwen/Qwen3-32B (404): check "upstreamModel" for qwen3-32b in provider.json (orrery provider check lists what the server serves)');
    assert.equal(refusal(401, '', offer).log, 'the model server refused the node’s key (401): check upstream.apiKey or upstream.apiKeyEnv in provider.json');
    assert.equal(refusal(503, 'busy', offer).log, 'the model server is busy (503) and turned a qwen3-32b request away');
  });

  it('says which kind each refusal was, keeps them, and counts the last 24 hours by kind', () => {
    assert.equal(refusal(400, vllm, offer).kind, 'too_long');
    assert.equal(refusal(404, 'model not found', offer).kind, 'unknown_model');
    assert.equal(refusal(401, '', offer).kind, 'key');
    assert.equal(refusal(503, '', offer).kind, 'busy');
    assert.equal(refusal(400, 'something else', offer).kind, 'other');
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-refused-')), 'refused.jsonl');
    const now = Date.now();
    appendRefused(path, { at: now - 2 * 86_400_000, model: 'a', kind: 'busy' });
    appendRefused(path, { at: now - 1_000, model: 'a', kind: 'too_long' });
    appendRefused(path, { at: now - 500, model: 'b', kind: 'too_long' });
    appendRefused(path, { at: now - 100, model: 'b', kind: 'busy' });
    const c = refusedCounts(readRefused(path), 86_400_000, now);
    assert.deepEqual(c, { too_long: 2, busy: 1 });
    assert.equal(refusedText(c), '3 in the last 24 h: 2 longer than it serves, 1 busy');
    assert.equal(refusedText({}), 'none in the last 24 h');
  });
});
