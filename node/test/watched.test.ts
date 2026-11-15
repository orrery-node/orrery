import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answeredText, loadWatched, saveWatched, watchedText } from '../src/router/watched.ts';
import { Stats } from '../src/router/policy.ts';

describe('a router’s record on disk', () => {
  it('comes back as it was written, so a restart does not start the record over', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-watched-')), 'router', 'watched.json');
    const m = new Map([['NodeA', { checks: 120, up: 118, since: 1_794_000_000_000 }], ['NodeB', { checks: 3, up: 0, since: 1_794_000_100_000 }]]);
    saveWatched(path, m);
    assert.deepEqual([...loadWatched(path)], [...m]);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).NodeA.up, 118);
  });

  it('starts empty from a missing or broken file, and drops entries that are not a record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-watched-'));
    assert.equal(loadWatched(join(dir, 'none.json')).size, 0);
    writeFileSync(join(dir, 'broken.json'), '{not json');
    assert.equal(loadWatched(join(dir, 'broken.json')).size, 0);
    writeFileSync(join(dir, 'mixed.json'), JSON.stringify({ Good: { checks: 5, up: 4, since: 10 }, MoreUpThanChecks: { checks: 2, up: 9, since: 10 }, Negative: { checks: -1, up: 0, since: 10 }, Text: 'x' }));
    assert.deepEqual([...loadWatched(join(dir, 'mixed.json')).keys()], ['Good']);
    assert.equal(loadWatched(undefined).size, 0);
  });
});

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

describe('a router’s own count of what a node did with its requests', () => {
  it('counts a request the node answered, one it did not, and one it answered against its own listing', () => {
    const s = new Stats();
    s.ok('A', 120);
    s.ok('A', 80);
    s.fail('A');
    s.ok('A', 90);
    s.penalize('A');
    const o = s.get('A') as unknown as { ok: number; fail: number; broke?: number };
    assert.equal(o.ok, 3);
    assert.equal(o.fail, 2, 'both count against its standing with this router');
    assert.equal(o.broke, 1, 'but only one of them was a request left unanswered');
    assert.equal(answeredText(o), 'answered 3 of 4 requests this router sent it since it started');
  });

  it('says it in words, and nothing before the first request', () => {
    assert.equal(answeredText({ ok: 1, fail: 0 }), 'answered the 1 request this router sent it since it started');
    assert.equal(answeredText({ ok: 41, fail: 0 }), 'answered all 41 requests this router sent it since it started');
    assert.equal(answeredText({ ok: 0, fail: 3 }), 'answered 0 of 3 requests this router sent it since it started');
    assert.equal(answeredText({ ok: 1204, fail: 2 }), 'answered 1,204 of 1,206 requests this router sent it since it started');
    assert.equal(answeredText({ ok: 0, fail: 0 }), '');
    assert.equal(answeredText(null), '');
    assert.equal(answeredText(undefined), '');
  });
});

describe('the count of answered requests, kept with the record on disk', () => {
  it('survives a restart and says over how long', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-asked-'));
    const path = join(dir, 'watched.json');
    const now = Date.now();
    saveWatched(path, new Map([['A', { checks: 10, up: 9, since: now - 7_200_000, sent: 43, answered: 41, askedSince: now - 3 * 86_400_000 } as never], ['B', { checks: 2, up: 2, since: now - 60_000 }]]));
    const back = loadWatched(path);
    assert.deepEqual(back.get('A'), { checks: 10, up: 9, since: now - 7_200_000, sent: 43, answered: 41, askedSince: now - 3 * 86_400_000 });
    assert.deepEqual(back.get('B'), { checks: 2, up: 2, since: now - 60_000 });
    assert.equal(answeredText(back.get('A') as never, now), 'answered 41 of 43 requests this router sent it over 3 days');
    assert.equal(answeredText(back.get('B') as never, now), '');
    assert.equal(answeredText({ checks: 1, up: 1, since: now, sent: 2, answered: 2, askedSince: now - 300_000 } as never, now), 'answered all 2 requests this router sent it over 5 min');
  });

  it('drops counts that cannot be true and keeps the rest of the record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-asked-'));
    const path = join(dir, 'watched.json');
    writeFileSync(path, JSON.stringify({ A: { checks: 3, up: 3, since: 5, sent: 2, answered: 9, askedSince: 5 }, B: { checks: 3, up: 3, since: 5, sent: -1, answered: 0, askedSince: 5 } }));
    const back = loadWatched(path);
    assert.deepEqual(back.get('A'), { checks: 3, up: 3, since: 5 });
    assert.deepEqual(back.get('B'), { checks: 3, up: 3, since: 5 });
  });
});
