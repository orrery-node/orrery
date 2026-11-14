import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watchedText } from '../src/router/watched.ts';

describe('a router’s own record of a node', () => {
  it('says how many of its checks found the node up, and over how long', () => {
    const now = 1_800_000_000_000;
    assert.equal(watchedText({ checks: 120, up: 118, since: now - 3_600_000 }, now), 'up in 118 of 120 checks this router made over 1 h');
    assert.equal(watchedText({ checks: 4, up: 4, since: now - 95_000 }, now), 'up in 4 of 4 checks this router made over 2 min');
    assert.equal(watchedText({ checks: 1, up: 0, since: now - 5_000 }, now), 'up in 0 of 1 check this router made over 5 s');
    assert.equal(watchedText({ checks: 8640, up: 8611, since: now - 3 * 86_400_000 }, now), 'up in 8,611 of 8,640 checks this router made over 3 days');
    assert.equal(watchedText(null, now), '');
    assert.equal(watchedText({ checks: 0, up: 0, since: now }, now), '');
  });
});
