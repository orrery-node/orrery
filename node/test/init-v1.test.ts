import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findUpstream } from '../src/provider/init.ts';

const only = (path: string) => (async (url: string) => {
  if (new URL(url).pathname === path) return new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b', owned_by: 'library' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('not found', { status: 404 });
}) as unknown as Parameters<typeof findUpstream>[1];

describe('provider init --upstream without /v1', () => {
  it('finds the server under /v1 and writes that address', async () => {
    const found = await findUpstream('http://127.0.0.1:11434', only('/v1/models'));
    assert.equal(found.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.deepEqual(found.models, ['llama3.1:8b']);
  });

  it('keeps an address that answers as given', async () => {
    assert.equal((await findUpstream('http://127.0.0.1:8000/', only('/models'))).baseUrl, 'http://127.0.0.1:8000');
    assert.equal((await findUpstream('http://127.0.0.1:8000/v1', only('/v1/models'))).baseUrl, 'http://127.0.0.1:8000/v1');
  });

  it('says both places it looked when neither answers', async () => {
    await assert.rejects(findUpstream('http://127.0.0.1:9', only('/nowhere')), /^Error: no model server answered at http:\/\/127\.0\.0\.1:9\/models or http:\/\/127\.0\.0\.1:9\/v1\/models$/);
    await assert.rejects(findUpstream('http://127.0.0.1:9/v1', only('/nowhere')), /^Error: no model server answered at http:\/\/127\.0\.0\.1:9\/v1\/models$/);
  });
});
