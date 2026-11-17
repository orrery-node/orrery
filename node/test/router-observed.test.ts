import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stats } from '../src/router/policy.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'orrery-observed-'));

describe('the router’s own count of each node, kept on disk', () => {
  it('comes back after a restart: answers, failures, broken promises and speed, but no cooldown', () => {
    const path = join(dir(), 'router', 'observed.json');
    const s = new Stats(path);
    s.ok('A', 100);
    s.ok('A', 200);
    s.fail('A');
    s.penalize('B');
    s.flush();
    const again = new Stats(path);
    assert.deepEqual(again.get('A'), { ttftMs: 130, ok: 2, fail: 1, cooldownUntil: 0 });
    assert.deepEqual(again.get('B'), { ttftMs: null, ok: 0, fail: 1, broke: 1, cooldownUntil: 0 });
  });

  it('lets go of a node it has not seen in 30 days, and reads a broken file as nothing', () => {
    const path = join(dir(), 'observed.json');
    const old = Date.now() - 31 * 86_400_000;
    writeFileSync(path, JSON.stringify({ A: { ttftMs: 90, ok: 5, fail: 0, at: old }, B: { ttftMs: 80, ok: 3, fail: 1, at: Date.now() }, C: { ok: 'many' } }));
    const s = new Stats(path);
    assert.equal(s.get('A').ok, 0);
    assert.equal(s.get('B').ok, 3);
    assert.equal(s.get('C').ok, 0);
    writeFileSync(path, '{not json');
    assert.equal(new Stats(path).get('B').ok, 0);
  });

  it('writes nothing when it has no file to keep', () => {
    const s = new Stats();
    s.ok('A', 50);
    s.flush();
    assert.equal(s.get('A').ok, 1);
  });

  it('writes soon after a change, not on every request', async () => {
    const path = join(dir(), 'observed.json');
    const s = new Stats(path, 50);
    s.ok('A', 10);
    s.ok('A', 20);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as Record<string, { ok: number }>).A.ok, 2);
  });
});
