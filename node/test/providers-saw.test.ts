import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sawLine } from '../src/router/watched.ts';

const now = Date.parse('2026-11-17T12:00:00Z');
const hour = 3_600_000;

describe('what your router saw of a node, for orrery providers', () => {
  it('puts the health checks, the requests and the speed on one line', () => {
    const w = { checks: 120, up: 118, since: now - hour, sent: 43, answered: 41, askedSince: now - 3 * hour };
    assert.equal(sawLine(w, { ttftMs: 960, ok: 41, fail: 2, cooldownUntil: 0 }, now), 'what your router saw: up in 118 of 120 checks this router made over 1 h; answered 41 of 43 requests this router sent it over 3 h; first token in about 960 ms lately');
  });

  it('says only what it has, and nothing for a node it never saw', () => {
    assert.equal(sawLine({ checks: 4, up: 4, since: now - 120_000 }, undefined, now), 'what your router saw: up in 4 of 4 checks this router made over 2 min');
    assert.equal(sawLine(undefined, { ttftMs: null, ok: 0, fail: 0, cooldownUntil: 0 }, now), '');
    assert.equal(sawLine(undefined, undefined, now), '');
  });
});
