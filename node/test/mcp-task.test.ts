import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/mcp.ts';

type Reply = { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> };
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({ ok: status < 400, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body });
const call = async (name: string, args: Record<string, unknown>, fetchFn: (url: string) => Promise<Reply>) =>
  (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'http://r', fetchFn, '0')) as { result: { content: { text: string }[]; isError?: boolean } };

describe('orrery mcp and task budgets', () => {
  it('an answer under a task says what the task has spent and has left', async () => {
    const out = await call('ask', { model: 'm', prompt: 'hi', task: 'review', task_budget: 0.00005 }, async () =>
      reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-cost': '0.000020', 'x-orrery-task-spent': '0.000020', 'x-orrery-task-left': '0.000030' }));
    assert.match(out.result.content[0].text, /^Hello\.\n\n— answered by 76Udba… via route auto, paid \$0\.000020 for this answer\n— task review: \$0\.000020 spent, \$0\.000030 left$/);
  });

  it('a refusal for the task’s budget says the same, so the agent knows to stop or raise it', async () => {
    const out = await call('ask', { model: 'm', prompt: 'hi', task: 'review' }, async () =>
      reply({ error: { code: 'over_budget', message: 'no provider can answer m within $0.000004 for this request' } }, 402, { 'x-orrery-task-spent': '0.000046', 'x-orrery-task-left': '0.000004' }));
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0].text, /the router could not answer: no provider can answer m within \$0\.000004 for this request\n— task review: \$0\.000046 spent, \$0\.000004 left/);
  });

  it('status tells an agent how each node gets the request and the payment', async () => {
    const out = await call('status', {}, async (url) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0', channels: [], providers: [
        { address: 'A1', name: 'Seed', modelServer: 'up', healthMs: 12, sealing: 'inside' },
        { address: 'B2', name: 'Old', modelServer: 'up', sealing: 'request' },
        { address: 'C3', name: 'Plain', modelServer: 'up', sealing: 'plain' },
        { address: 'D4', name: 'Hidden', modelServer: 'up', sealing: 'withheld' },
      ] });
      return reply({ rows: [] });
    });
    const t = out.result.content[0].text;
    assert.match(t, /Seed: model server up \(12 ms\), request and payment sealed to it/);
    assert.match(t, /Old: model server up, request sealed, payment in headers its host can read/);
    assert.match(t, /Plain: model server up, plain JSON its host can read/);
    assert.match(t, /Hidden: model server up, nothing sent: its wire key went missing/);
  });

  it('status lists the tasks with what each has left', async () => {
    const out = await call('status', {}, async (url) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0.000046', channels: [], providers: [] });
      if (url.endsWith('/orrery/tasks')) return reply({ tasks: [{ name: 'review', budget: '0.000050', spent: '0.000046', left: '0.000004', answers: 2 }, { name: 'docs', budget: '0.010000', spent: '0.000000', left: '0.010000', answers: 0 }] });
      return reply({ rows: [] });
    });
    assert.match(out.result.content[0].text, /\ntasks:\nreview: \$0\.000046 of \$0\.000050 spent, \$0\.000004 left, 2 answers\ndocs: \$0\.000000 of \$0\.010000 spent, \$0\.010000 left, 0 answers/);
  });
});
