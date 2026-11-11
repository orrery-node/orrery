import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY_FIELDS, identityIn, withoutIdentity } from '../src/router/identity.ts';
import { toOpenAI } from '../src/router/anthropic.ts';
import { responsesToChat } from '../src/router/responses.ts';
import { upstreamBody } from '../src/provider/node.ts';

test('the router drops every field that says who the end user is, and nothing else', () => {
  const body = {
    model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'my name is in the prompt, and that is mine to write' }], temperature: 0.2, max_tokens: 64,
    user: 'alice@example.com', metadata: { account: 'acct_123' }, safety_identifier: 'sid_9', prompt_cache_key: 'alice-session-4',
  };
  const out = withoutIdentity(body);
  for (const k of IDENTITY_FIELDS) assert.ok(!(k in out), k);
  assert.deepEqual(Object.keys(out).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
  assert.deepEqual(out.messages, body.messages);
  assert.equal(body.user, 'alice@example.com', 'the caller’s own object is not changed');
});

test('Claude Code’s account, device and session id is not turned into a user field', () => {
  const out = toOpenAI({
    model: 'claude-sonnet-4-5', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: 'user_3f9c_account_6b1e2c1e-0000-4000-8000-000000000001_session_0d5a' },
  });
  assert.ok(!('user' in out) && !('metadata' in out));
  assert.ok(!JSON.stringify(out).includes('account_6b1e2c1e'));
});

test('a Responses request’s user id is not carried over', () => {
  const out = responsesToChat({ model: 'gpt-oss-120b', input: 'hi', user: 'u_42' });
  assert.ok(!('user' in out));
  assert.ok(!JSON.stringify(out).includes('u_42'));
});

test('a node does not pass a user id to its model server, whatever router sent it', () => {
  const out = upstreamBody({ messages: [{ role: 'user', content: 'hi' }], user: 'alice@example.com', metadata: { a: 1 }, safety_identifier: 's' }, 'some/model', 64);
  assert.deepEqual(Object.keys(out).sort(), ['max_tokens', 'messages', 'model', 'stream', 'stream_options']);
});

test('the names of what a client attached are reported, never the values', () => {
  assert.deepEqual(identityIn({ model: 'm', user: 'alice@example.com', metadata: { user_id: 'x' }, messages: [] }), ['user', 'metadata']);
  assert.deepEqual(identityIn({ model: 'm', user: null, messages: [] }), []);
  assert.deepEqual(identityIn({ model: 'm', messages: [] }), []);
});
