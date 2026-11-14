import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWatched, saveWatched, watchedText } from '../src/router/watched.ts';

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
