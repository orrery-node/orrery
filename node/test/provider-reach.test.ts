import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reach, reachLine } from '../src/provider/reach.ts';

describe('whether anything outside is reaching the node', () => {
  it('counts the last hour and forgets what is older', () => {
    const t0 = 1_000_000_000;
    const r = new Reach(t0);
    r.note(t0 + 1_000);
    r.note(t0 + 3_000_000);
    r.note(t0 + 3_600_000);
    assert.deepEqual(r.read(t0 + 3_601_500), { lastHour: 2, lastAt: t0 + 3_600_000, upMs: 3_601_500 });
    assert.deepEqual(r.read(t0 + 9_000_000), { lastHour: 0, lastAt: null, upMs: 9_000_000 });
  });

  it('keeps a bounded number of times, however many checks come', () => {
    const r = new Reach(0);
    for (let i = 0; i < 20_500; i++) r.note(i);
    assert.equal(r.read(20_500).lastHour, 20_000);
  });

  it('says how often and how lately, and tells silence just after a start from silence that means something', () => {
    const now = 10_000_000;
    assert.equal(reachLine({ lastHour: 118, lastAt: now - 12_000, upMs: 7_200_000 }, 'provider.json', now), '  checked from outside  118 times in the last hour, the last 12 s ago');
    assert.equal(reachLine({ lastHour: 1, lastAt: now - 180_000, upMs: 7_200_000 }, 'provider.json', now), '  checked from outside  1 time in the last hour, the last 3 min ago');
    assert.equal(reachLine({ lastHour: 0, lastAt: null, upMs: 45_000 }, 'provider.json', now), '  checked from outside  not yet, 45 s since this node started');
    assert.equal(reachLine({ lastHour: 0, lastAt: null, upMs: 720_000 }, 'provider.json', now), '  checked from outside  not in the last hour. A router that knows this node asks every 30 s, so either none is running or the public address does not reach it: orrery provider check --config provider.json');
  });
});
