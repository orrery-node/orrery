import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskBook } from '../src/router/tasks.ts';

describe('task budgets', () => {
  it('one budget for every request under a task name', () => {
    const b = new TaskBook();
    assert.equal(b.open('refactor-42', 50_000n).left, 50_000n);
    b.spend('refactor-42', 20_000n);
    assert.equal(b.open('refactor-42', null).left, 30_000n);
    b.spend('refactor-42', 30_000n);
    assert.equal(b.open('refactor-42', null).left, 0n);
    assert.equal(b.list()[0].answers, 2);
  });
  it('a later budget can lower the first one, never raise it; a new task needs a budget; names are checked', () => {
    const b = new TaskBook();
    b.open('t', 50_000n);
    assert.equal(b.open('t', 90_000n).left, 50_000n);
    assert.equal(b.open('t', 10_000n).left, 10_000n);
    assert.throws(() => b.open('fresh', null), /no budget yet/);
    assert.throws(() => b.open('bad name!', 1n), /task name/);
  });
  it('forgets the oldest task past its limit', () => {
    const b = new TaskBook(2);
    b.open('a', 1n); b.open('b', 1n); b.open('c', 1n);
    assert.deepEqual(b.list().map((t) => t.name), ['c', 'b']);
  });
  it('with a path, a restarted router still knows what a job has spent, and drops tasks idle for a week', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-tasks-')), 'router', 'tasks.json');
    const first = new TaskBook(1_000, path, 1_000);
    first.open('long-job', 50_000n, 1_000);
    first.spend('long-job', 20_000n, 2_000);
    const second = new TaskBook(1_000, path, 3_000);
    assert.equal(second.open('long-job', null, 3_000).left, 30_000n);
    const weekLater = new TaskBook(1_000, path, 3_000 + 8 * 86_400_000);
    assert.throws(() => weekLater.open('long-job', null), /no budget yet/);
  });
});

describe('a job named in the API key', async () => {
  const { apiKeyOf, taskFromKey, taskKey } = await import('../src/router/tasks.ts');
  it('reads orrery/<task> and orrery/<task>/<budget>, and nothing else', () => {
    assert.deepEqual(taskFromKey('orrery/refactor/0.25'), { name: 'refactor', budget: '0.25' });
    assert.deepEqual(taskFromKey('orrery/nightly-run.2'), { name: 'nightly-run.2', budget: null });
    assert.deepEqual(taskFromKey(' orrery/a:b/3 '), { name: 'a:b', budget: '3' });
    for (const k of ['orrery', 'sk-ant-abc', 'unused', '', null, undefined, 'orrery/', 'orrery/bad name/1', 'orrery/x/abc', 'orrery/x/1/2', 'other/x/1']) assert.equal(taskFromKey(k as string), null, String(k));
  });
  it('finds the key where each API puts it', () => {
    assert.equal(apiKeyOf({ authorization: 'Bearer orrery/job/1' }), 'orrery/job/1');
    assert.equal(apiKeyOf({ authorization: 'bearer  orrery/job/1 ' }), 'orrery/job/1');
    assert.equal(apiKeyOf({ 'x-api-key': 'orrery/job' }), 'orrery/job');
    assert.equal(apiKeyOf({}), null);
    assert.equal(taskKey('job', '0.5'), 'orrery/job/0.5');
    assert.equal(taskKey('job'), 'orrery/job');
    assert.deepEqual(taskFromKey(taskKey('claude-app-1111-0834', '0.05')), { name: 'claude-app-1111-0834', budget: '0.05' });
  });
});
