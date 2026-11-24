import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTargets, targetKey } from '../src/router/relay.ts';

describe('a relay only reaches listed nodes', () => {
  it('keys each node endpoint by host and port, with the default port when none is written', () => {
    assert.deepEqual([...allowedTargets(['https://node.example.com', 'http://127.0.0.1:7272/', 'https://[::1]:8443', 'ftp://x', 'not a url'])], ['node.example.com:443', '127.0.0.1:7272', '::1:8443']);
    assert.equal(targetKey('NODE.example.com', '', 'https:'), 'node.example.com:443');
    assert.equal(targetKey('127.0.0.1', 80, 'http:'), '127.0.0.1:80');
  });
});
