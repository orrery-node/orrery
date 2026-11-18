import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as reach from '../src/provider/reach.ts';
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

  it('says in the node log when something outside first reaches it, and once when nothing has after three minutes', () => {
    const r = reach as unknown as { firstReachNote?: (upMs: number) => string; quietNote?: (upMs: number) => string };
    assert.equal(typeof r.firstReachNote, 'function', 'reach.ts writes the lines');
    assert.equal(r.firstReachNote!(42_000), 'reached from outside 42 s after starting: the public address works, and routers that know this node check it every 30 s');
    assert.equal(r.firstReachNote!(380_000), 'reached from outside 6 min after starting: the public address works, and routers that know this node check it every 30 s');
    assert.equal(r.quietNote!(180_000), 'nothing outside this computer has checked this node in the 3 min since it started; routers that know it check every 30 s, so either none is running or the public address does not reach it: orrery provider check says which');
  });

  it('says first reach once, however many checks come', () => {
    const r = new Reach(0) as unknown as { note: (now: number) => boolean };
    assert.equal(r.note(1_000), true);
    assert.equal(r.note(2_000), false);
    assert.equal(r.note(3_000), false);
  });

  it('says it in a sentence for the console, from the same numbers', () => {
    const say = (reach as unknown as { reachSentence?: (r: unknown, now: number) => string }).reachSentence;
    assert.equal(typeof say, 'function', 'reach.ts writes the sentence');
    const now = 10_000_000;
    assert.equal(say!({ lastHour: 118, lastAt: now - 12_000, upMs: 7_200_000 }, now), 'Checked from outside this computer 118 times in the last hour, the last 12 s ago: routers can reach this node.');
    assert.equal(say!({ lastHour: 1, lastAt: now - 180_000, upMs: 7_200_000 }, now), 'Checked from outside this computer 1 time in the last hour, the last 3 min ago: routers can reach this node.');
    assert.equal(say!({ lastHour: 0, lastAt: null, upMs: 45_000 }, now), 'Not checked from outside this computer yet, 45 s since this node started.');
    assert.equal(say!({ lastHour: 0, lastAt: null, upMs: 720_000 }, now), 'Not checked from outside this computer in the last hour. A router that knows this node asks every 30 s, so either none is running or the public address does not reach it: orrery provider check says which.');
    assert.equal(say!(undefined, now), '');
  });
});
