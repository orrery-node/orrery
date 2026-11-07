import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLocal } from '../src/provider/console.ts';

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers });

describe('provider console access', () => {
  it('answers requests from this computer', () => {
    assert.ok(isLocal(req('127.0.0.1')));
    assert.ok(isLocal(req('::1')));
    assert.ok(isLocal(req('::ffff:127.0.0.1')));
  });

  it('refuses anyone else', () => {
    assert.ok(!isLocal(req('203.0.113.7')));
    assert.ok(!isLocal(req('10.0.0.4')));
    assert.ok(!isLocal(req('')));
  });

  it('refuses a request relayed by a proxy on the same machine', () => {
    assert.ok(!isLocal(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })));
    assert.ok(!isLocal(req('127.0.0.1', { forwarded: 'for=203.0.113.7' })));
    assert.ok(!isLocal(req('::1', { 'x-real-ip': '203.0.113.7' })));
  });
});
