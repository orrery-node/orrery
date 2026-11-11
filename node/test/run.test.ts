import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModel, plan, readBill, renderBill, routerModels, taskName } from '../src/run.ts';

test('a task name comes from the client, the folder and the UTC time, and fits the router’s rule', () => {
  const at = new Date('2026-11-11T08:34:05Z');
  assert.equal(taskName('claude', '/Users/dev/code/todo-app', at), 'claude-todo-app-1111-0834');
  assert.equal(taskName('claude', '/tmp/My Project (v2)!', at), 'claude-my-project-v2-1111-0834');
  assert.equal(taskName('claude', '/', at), 'claude-job-1111-0834');
  const long = taskName('claude', `/x/${'a'.repeat(200)}`, at);
  assert.match(long, /^[A-Za-z0-9._:\-]{1,64}$/);
});

test('the model is gpt-oss-120b when listed, else the longest context', () => {
  assert.equal(pickModel([{ id: 'llama-3.3-70b', context_length: 131072 }, { id: 'gpt-oss-120b', context_length: 131072 }]), 'gpt-oss-120b');
  assert.equal(pickModel([{ id: 'small', context_length: 8192 }, { id: 'big', context_length: 262144 }, {}]), 'big');
  assert.equal(pickModel([]), undefined);
});

test('the plan points Claude Code at the router, tags the job, and passes no key on', () => {
  const p = plan('claude', {
    router: 'http://127.0.0.1:7171/', task: 'claude-todo-1111-0834', budget: '0.05', model: 'gpt-oss-120b', args: ['-p', 'hi'],
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-real', ANTHROPIC_AUTH_TOKEN: 'real-token', ANTHROPIC_CUSTOM_HEADERS: 'x-team: a\nx-orrery-task: old\nx-orrery-task-budget: 9', NOPE: undefined },
  });
  assert.equal(p.command, 'claude');
  assert.deepEqual(p.args, ['--model', 'gpt-oss-120b', '-p', 'hi']);
  assert.equal(p.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:7171');
  assert.equal(p.env.ANTHROPIC_API_KEY, 'orrery');
  assert.equal(p.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.ok(!JSON.stringify(p.env).includes('sk-ant-real') && !JSON.stringify(p.env).includes('real-token'));
  assert.equal(p.env.ANTHROPIC_CUSTOM_HEADERS, 'x-team: a\nx-orrery-task: claude-todo-1111-0834\nx-orrery-task-budget: 0.05');
  assert.equal(p.env.ANTHROPIC_SMALL_FAST_MODEL, 'gpt-oss-120b');
  assert.equal(p.env.PATH, '/bin');
  assert.ok(!('NOPE' in p.env));
});

test('a model the user names for the client is left alone, and no budget means no budget header', () => {
  const p = plan('claude', { router: 'http://r', task: 't', model: 'gpt-oss-120b', args: ['--model', 'qwen3-coder'], env: {} });
  assert.deepEqual(p.args, ['--model', 'qwen3-coder']);
  assert.equal(p.env.ANTHROPIC_CUSTOM_HEADERS, 'x-orrery-task: t');
});

const routerStub = (tasks: unknown, rows: unknown, ok = true) => async (url: string) => ({
  ok,
  json: async () => (url.includes('/orrery/tasks') ? { tasks } : url.includes('/orrery/spend') ? { rows } : { data: [{ id: 'gpt-oss-120b', context_length: 131072 }] }),
});

test('the bill joins the task book (money) with the log of answers (tokens)', async () => {
  const bill = await readBill('http://r/', 'job', routerStub(
    [{ name: 'job', budget: '0.050000', spent: '0.004062', answers: 7 }, { name: 'other', budget: '1.000000', spent: '0.5', answers: 3 }],
    [{ key: 'job', answers: 7, inputTokens: 91156, outputTokens: 4571, usd: '0.004062' }],
  ));
  assert.deepEqual(bill, { task: 'job', answers: 7, inputTokens: 91156, outputTokens: 4571, spent: '0.004062', budget: '0.050000' });
  assert.equal(renderBill(bill, 'job'), 'orrery · job\n  7 answers · 95,727 tokens (91,156 in, 4,571 out) · $0.004062 of $0.05 budget\n  each answer paid from your wallet to the node that served it');
});

test('a session with no paid answer and a router that went away both say so', async () => {
  const none = await readBill('http://r', 'job', routerStub([], []));
  assert.equal(renderBill(none, 'job'), 'orrery · job\n  no paid answers in this session');
  const gone = await readBill('http://r', 'job', async () => { throw new Error('refused'); });
  assert.equal(gone, null);
  assert.match(renderBill(gone, 'job'), /the router did not answer/);
  const one = renderBill({ task: 'job', answers: 1, inputTokens: 10, outputTokens: 5, spent: '0.000001' }, 'job');
  assert.match(one, /1 answer · 15 tokens \(10 in, 5 out\) · \$0\.000001\n/);
  const small = renderBill({ task: 'job', answers: 1, inputTokens: 10, outputTokens: 5, spent: '0.000001', budget: '0.001000' }, 'job');
  assert.match(small, /\$0\.000001 of \$0\.001 budget\n/);
  assert.match(renderBill({ task: 'job', answers: 2, inputTokens: 1, outputTokens: 1, spent: '0.5', budget: '1.000000' }, 'job'), /of \$1\.00 budget/);
});

test('routerModels reads the list, and returns null when nothing is there', async () => {
  assert.deepEqual(await routerModels('http://r', routerStub([], [])), [{ id: 'gpt-oss-120b', context_length: 131072 }]);
  assert.equal(await routerModels('http://r', routerStub([], [], false)), null);
  assert.equal(await routerModels('http://r', async () => { throw new Error('refused'); }), null);
});
