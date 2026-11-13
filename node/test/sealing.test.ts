import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sealCheck } from '../src/doctor.ts';
import type { ProviderEntry } from '../src/router/registry.ts';

const entry = (wire: boolean, inside: boolean) => ({ wire: wire ? Buffer.alloc(32, 1) : null, wireInside: inside }) as unknown as ProviderEntry;

describe('orrery doctor: how a request and its payment travel to a node', () => {
  it('says both go sealed when the node signed its wire key and the flag', () => {
    const l = sealCheck(entry(true, true), false);
    assert.equal(l.ok, true);
    assert.match(l.detail, /payment/);
  });
  it('adds that this router keeps to it once it has seen it signed', () => {
    assert.match(sealCheck(entry(true, true), true).detail, /keeps to/);
  });
  it('says payment goes in headers when the node does not sign that it reads it inside', () => {
    const l = sealCheck(entry(true, false), false);
    assert.equal(l.ok, null);
    assert.match(l.detail, /headers/);
  });
  it('says a node without a wire key is sent plain JSON its host can read', () => {
    const l = sealCheck(entry(false, false), false);
    assert.equal(l.ok, null);
    assert.match(l.detail, /plain/);
  });
  it('fails a node that showed a signed wire key before and shows none now', () => {
    const l = sealCheck(entry(false, false), true);
    assert.equal(l.ok, false);
    assert.match(l.detail, /nothing goes to it in the clear/);
  });
});
