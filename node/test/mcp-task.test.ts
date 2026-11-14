import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/mcp.ts';

type Reply = { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> };
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}): Reply => ({ ok: status < 400, status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, json: async () => body });
const call = async (name: string, args: Record<string, unknown>, fetchFn: (url: string) => Promise<Reply>) =>
  (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'http://r', fetchFn, '0')) as { result: { content: { text: string }[]; isError?: boolean } };

describe('orrery mcp and task budgets', () => {
  it('with no router to talk to, every tool says so and gives the command that starts one', async () => {
    const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7171'), { code: 'ECONNREFUSED' }) }); };
    for (const [tool, args] of [['ask', { model: 'm', prompt: 'hi' }], ['models', {}], ['quote', { model: 'm' }], ['status', {}]] as const) {
      const out = await call(tool, args, refused);
      assert.equal(out.result.isError, true, tool);
      assert.match(out.result.content[0].text, /^no Orrery router is answering at http:\/\/r\. Start one with: npx -y orrery-node router --wallet <your keypair\.json>/, tool);
      assert.match(out.result.content[0].text, /--router <its address>/, tool);
    }
  });

  it('a router that answers but breaks keeps its own error', async () => {
    const out = await call('models', {}, async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } }));
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0].text, /^the router at http:\/\/r answered with something unexpected: Unexpected token </);
  });

  it('an answer under a task says what the task has spent and has left', async () => {
    const out = await call('ask', { model: 'm', prompt: 'hi', task: 'review', task_budget: 0.00005 }, async () =>
      reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-cost': '0.000020', 'x-orrery-task-spent': '0.000020', 'x-orrery-task-left': '0.000030' }));
    assert.match(out.result.content[0].text, /^Hello\.\n\n— answered by 76Udba… via route auto, paid \$0\.000020 for this answer\n— traveled as plain JSON inside TLS, which the node’s host can read\n— task review: \$0\.000020 spent, \$0\.000030 left$/);
  });

  it('an answer names the node that gave it, decoding a name the router had to percent-encode', async () => {
    const named = async (name: string) => (await call('ask', { model: 'm', prompt: 'hi' }, async () => reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-provider-name': name, 'x-orrery-cost': '0.000082' }))).result.content[0].text;
    assert.match(await named('Orrery Seed'), /\n— answered by Orrery Seed \(76Udba…\) via route auto, paid \$0\.000082 for this answer\n/);
    assert.match(await named(encodeURIComponent('Nœud Paris')), /— answered by Nœud Paris \(76Udba…\)/);
    assert.match(await named('100%25 GPU'), /— answered by 100% GPU \(76Udba…\)/);
    assert.match(await named('%E0%A4%A'), /— answered by %E0%A4%A \(76Udba…\)/);
  });

  it('ask can stay with one node, by the name status lists or by its address, and says so when no node has that name', async () => {
    const seen: { url: string; headers?: Record<string, string> }[] = [];
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, headers: init?.headers });
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0', channels: [], providers: [{ address: '76UdbaSy69DdFv2ciRNQCbyz7ARVZvH4aVJwqBnszDE8', name: 'Orrery Seed' }, { address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', name: 'Halo Compute' }] });
      return reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69DdFv2ciRNQCbyz7ARVZvH4aVJwqBnszDE8', 'x-orrery-provider-name': 'Orrery Seed', 'x-orrery-cost': '0.000010' });
    };
    const byName = await call('ask', { model: 'm', prompt: 'hi', node: 'orrery seed' }, fake as never);
    assert.equal(byName.result.isError, undefined);
    assert.equal(seen.find((s) => s.url.endsWith('/v1/chat/completions'))?.headers?.['x-orrery-provider'], '76UdbaSy69DdFv2ciRNQCbyz7ARVZvH4aVJwqBnszDE8');
    seen.length = 0;
    await call('ask', { model: 'm', prompt: 'hi', node: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }, fake as never);
    assert.equal(seen.find((s) => s.url.endsWith('/v1/chat/completions'))?.headers?.['x-orrery-provider'], '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    seen.length = 0;
    const unknown = await call('ask', { model: 'm', prompt: 'hi', node: 'Ironbridge' }, fake as never);
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0].text, /^no node named Ironbridge is listed\. The router knows: Orrery Seed, Halo Compute$/);
    assert.ok(!seen.some((s) => s.url.endsWith('/v1/chat/completions')), 'nothing is asked when the name matches no node');
  });

  it('a refusal for the task’s budget says the same, so the agent knows to stop or raise it', async () => {
    const out = await call('ask', { model: 'm', prompt: 'hi', task: 'review' }, async () =>
      reply({ error: { code: 'over_budget', message: 'no provider can answer m within $0.000004 for this request' } }, 402, { 'x-orrery-task-spent': '0.000046', 'x-orrery-task-left': '0.000004' }));
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0].text, /the router could not answer: no provider can answer m within \$0\.000004 for this request\n— task review: \$0\.000046 spent, \$0\.000004 left/);
  });

  it('status gives an agent each node’s track record: how many times it has been paid out on chain', async () => {
    const out = await call('status', {}, async (url) => (url.endsWith('/orrery/status') ? reply({ spentToday: '0', channels: [], providers: [
      { address: 'A1', name: 'Seed', modelServer: 'up', healthMs: 12, sealing: 'inside', redeems: 147 },
      { address: 'B2', name: 'New', modelServer: 'up', sealing: 'inside', redeems: 1 },
    ] }) : reply({ rows: [] })));
    const t = out.result.content[0].text;
    assert.match(t, /Seed: model server up \(12 ms\), request and payment sealed to it, paid out 147 times on chain/);
    assert.match(t, /New: model server up, request and payment sealed to it, paid out once on chain/);
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

  it('an answer tells the agent how it traveled', async () => {
    const ask = (h: Record<string, string>) => call('ask', { model: 'm', prompt: 'hi' }, async () => reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-cost': '0.000020', ...h }));
    assert.match((await ask({ 'x-orrery-wire': '1', 'x-orrery-payment': 'inside' })).result.content[0].text, /\n— traveled sealed to the node’s own key, payment inside the seal$/);
    assert.match((await ask({ 'x-orrery-wire': '1', 'x-orrery-payment': 'headers' })).result.content[0].text, /\n— traveled sealed to the node’s own key, payment in headers its host can read$/);
    assert.match((await ask({ 'x-orrery-sealed': '1', 'x-orrery-enclave': 'AMD SEV-SNP', 'x-orrery-payment': 'inside' })).result.content[0].text, /\n— traveled sealed to a verified enclave \(AMD SEV-SNP\), payment inside the seal$/);
    assert.match((await ask({})).result.content[0].text, /\n— traveled as plain JSON inside TLS, which the node’s host can read$/);
  });

  it('status tells an agent how its requests leave this computer', async () => {
    const leaving = async (st: Record<string, unknown>) => (await call('status', {}, async (url) => (url.endsWith('/orrery/status') ? reply({ spentToday: '0', channels: [], providers: [], ...st }) : reply({ rows: [] })))).result.content[0].text.split('\n').find((l) => l.startsWith('leaving this computer:'));
    assert.equal(await leaving({ proxy: null, proxySeen: null }), 'leaving this computer: no proxy, so nodes see the address this computer’s requests leave from (orrery router --proxy hides it)');
    assert.equal(await leaving({ proxy: '127.0.0.1:8119', proxySeen: { node: 'Orrery Seed', address: '203.0.113.7', givenAway: null } }), 'leaving this computer: through the proxy at 127.0.0.1:8119; Orrery Seed sees 203.0.113.7');
    assert.equal(await leaving({ proxy: '127.0.0.1:8119', proxySeen: { node: 'Orrery Seed', address: '198.51.100.4', givenAway: '198.51.100.4' } }), 'leaving this computer: through the proxy at 127.0.0.1:8119, but Orrery Seed saw this computer’s own address (198.51.100.4); the router sends nothing until it does not');
    assert.equal(await leaving({ proxy: '127.0.0.1:8119', proxySeen: null }), 'leaving this computer: through the proxy at 127.0.0.1:8119; no node has said yet what address it sees');
    assert.match((await call('status', {}, async (url) => (url.endsWith('/orrery/status') ? reply({ spentToday: '0', channels: [], providers: [], privateOnly: true }) : reply({ rows: [] })))).result.content[0].text, /\nprivate only: every request goes sealed to an enclave this router verified, or not at all/);
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
