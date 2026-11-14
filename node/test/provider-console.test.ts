import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consoleLine, hasConsoleKey, isLocal } from '../src/provider/console.ts';

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers: { host: '127.0.0.1:17282', ...headers } });

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

  it('asks for the key kept on the node’s disk, by header or by ?key=, and nothing else will do', () => {
    const key = 'a'.repeat(32);
    const at = (path: string, headers: Record<string, string> = {}) => hasConsoleKey(req('127.0.0.1', headers), new URL(path, 'http://x'), key);
    assert.ok(at('/orrery/status', { 'x-orrery-console-key': key }));
    assert.ok(at(`/?key=${key}`));
    assert.ok(!at('/orrery/status'));
    assert.ok(!at('/orrery/status', { 'x-orrery-console-key': 'b'.repeat(32) }));
    assert.ok(!at('/?key=' + 'a'.repeat(31)));
    assert.ok(!at('/?key='));
  });

  it('the start line gives the key only to a terminal; a log gets the address and the command that prints it', () => {
    const key = 'c'.repeat(32);
    assert.equal(consoleLine(7272, key, true, 'provider.json'), `your console, on this computer only: http://127.0.0.1:7272/?key=${key}`);
    const logged = consoleLine(7272, key, false, 'provider.json');
    assert.ok(!logged.includes(key), 'no key in a log');
    assert.equal(logged, 'your console, on this computer only: http://127.0.0.1:7272/ (orrery provider console --config provider.json prints it with its key)');
  });

  it('refuses a page that points its own domain at this computer (DNS rebinding)', () => {
    assert.ok(!isLocal(req('127.0.0.1', { host: 'attacker.example:17282' })));
    assert.ok(isLocal(req('127.0.0.1', { host: 'localhost:17282' })));
    assert.ok(isLocal(req('::1', { host: '[::1]:17282' })));
  });
});
