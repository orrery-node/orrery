import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from '../src/router/server.ts';

describe('router host check', () => {
  it('reads the host part of a Host header', () => {
    assert.equal(hostname('127.0.0.1:7171'), '127.0.0.1');
    assert.equal(hostname('LOCALHOST:7171'), 'localhost');
    assert.equal(hostname('[::1]:7171'), '[::1]');
    assert.equal(hostname('attacker.example:7171'), 'attacker.example');
    assert.equal(hostname(undefined), '');
  });
});
