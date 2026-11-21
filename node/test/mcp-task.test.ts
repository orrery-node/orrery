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

  it('ask says when the model ran out of room: an answer cut off at the cap, or none at all', async () => {
    const said = async (content: string, finish: string, args: Record<string, unknown> = {}) => (await call('ask', { model: 'm', prompt: 'hi', ...args }, (async () => reply({ choices: [{ message: { content }, finish_reason: finish }] }, 200, { 'x-orrery-provider': '76UdbaSy69DdFv2ciRNQCbyz7ARVZvH4aVJwqBnszDE8', 'x-orrery-cost': '0.000038' })) as never)).result.content[0].text;
    const empty = await said('', 'length');
    assert.match(empty, /^\(no answer: the model used all 1024 output tokens before it wrote one\. A reasoning model thinks first and that counts\. Ask again with a larger max_tokens\.\)\n\n— answered by /);
    assert.match(empty, /paid \$0\.000038 for this answer/);
    assert.match(await said('', 'length', { max_tokens: 220 }), /^\(no answer: the model used all 220 output tokens/);
    const cut = await said('The first half of a', 'length', { max_tokens: 64 });
    assert.match(cut, /^The first half of a\n\n— answered by /);
    assert.match(cut, /\n— stopped at max_tokens 64, so the answer is cut off: ask with a larger max_tokens for all of it/);
    const whole = await said('Hello.', 'stop');
    assert.ok(!/max_tokens/.test(whole));
    assert.match(await said('', 'stop'), /^\(the model returned an empty answer\)\n\n— answered by /);
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

  it('an answer says how soon it started, from the router’s first-token time', async () => {
    const timed = async (ms: string) => (await call('ask', { model: 'm', prompt: 'hi' }, async () => reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-provider-name': 'Orrery Seed', 'x-orrery-cost': '0.000025', 'x-orrery-ttft-ms': ms }))).result.content[0].text;
    assert.match(await timed('703'), /— answered by Orrery Seed \(76Udba…\) in 703 ms via route auto, paid \$0\.000025 for this answer/);
    assert.match(await timed('1106'), /— answered by Orrery Seed \(76Udba…\) in 1\.1 s via route auto/);
    assert.match(await timed('x'), /— answered by Orrery Seed \(76Udba…\) via route auto/);
  });

  it('an answer that came after a node failed says so, with the rule: a node that does not answer is not paid', async () => {
    const after = async (n: string | null) => (await call('ask', { model: 'm', prompt: 'hi' }, async () => reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-provider-name': 'Vault Nine', 'x-orrery-cost': '0.000019', ...(n ? { 'x-orrery-skipped': n } : {}) }))).result.content[0].text;
    assert.match(await after('1'), /\n— 1 node failed before this one answered; a node that does not answer is not paid\n— traveled /);
    assert.match(await after('2'), /\n— 2 nodes failed before this one answered; a node that does not answer is not paid\n/);
    assert.ok(!(await after(null)).includes('failed before'));
    assert.ok(!(await after('0')).includes('failed before'));
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

  it('status gives an agent this router’s own record of each node: how many of its checks found the node up', async () => {
    const now = Date.now();
    const out = await call('status', {}, async (url) => (url.endsWith('/orrery/status') ? reply({ spentToday: '0', channels: [], providers: [
      { address: 'A1', name: 'Seed', modelServer: 'up', healthMs: 12, sealing: 'inside', redeems: 147, watched: { checks: 120, up: 118, since: now - 3_600_000 } },
      { address: 'B2', name: 'New', modelServer: 'up', sealing: 'inside', redeems: 1 },
    ] }) : reply({ rows: [] })));
    const t = out.result.content[0].text;
    assert.match(t, /Seed: model server up \(12 ms\), request and payment sealed to it, paid out 147 times on chain, up in 118 of 120 checks this router made over 1 h/);
    assert.match(t, /New: model server up, request and payment sealed to it, paid out once on chain$/m);
  });

  it('status gives an agent what each node did with this router’s own requests', async () => {
    const now = Date.now();
    const out = await call('status', {}, async (url) => (url.endsWith('/orrery/status') ? reply({ spentToday: '0', channels: [], providers: [
      { address: 'A1', name: 'Seed', modelServer: 'up', healthMs: 12, sealing: 'inside', redeems: 147, watched: { checks: 120, up: 118, since: now - 3_600_000 }, observed: { ok: 41, fail: 2, broke: 0 } },
      { address: 'B2', name: 'New', modelServer: 'up', sealing: 'inside', redeems: 1, observed: { ok: 0, fail: 0 } },
    ] }) : reply({ rows: [] })));
    const t = out.result.content[0].text;
    assert.match(t, /Seed: .*up in 118 of 120 checks this router made over 1 h, answered 41 of 43 requests this router sent it since it started$/m);
    assert.match(t, /New: model server up, request and payment sealed to it, paid out once on chain$/m);
  });

  it('status lists a node that stopped answering as that, with how long, and not as up', async () => {
    const now = Date.now();
    const out = await call('status', {}, async (url) => (url.endsWith('/orrery/status') ? reply({ spentToday: '0', channels: [], providers: [
      { address: 'A1', name: 'Gone', modelServer: 'up', healthMs: 12, sealing: 'inside', redeems: 9, answering: false, unansweredSince: now - 180_000, watched: { checks: 10, up: 4, since: now - 300_000 } },
      { address: 'B2', name: 'Here', modelServer: 'up', healthMs: 30, sealing: 'inside', redeems: 2, answering: true },
    ] }) : reply({ rows: [] })));
    const t = out.result.content[0].text;
    assert.match(t, /Gone: not answering health checks for 3 min, request and payment sealed to it, paid out 9 times on chain, up in 4 of 10 checks this router made over 5 min/);
    assert.ok(!/Gone: model server up/.test(t));
    assert.match(t, /Here: model server up \(30 ms\)/);
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

  it('status tells an agent how many answers came after a node did not answer, and that such a node is signed nothing', async () => {
    const withSkips = async (after: unknown) => (await call('status', {}, async (url) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0.000100', channels: [], providers: [] });
      if (url.includes('/orrery/spend')) return reply({ rows: [{ key: 'llama-3.3-70b', answers: 5, usd: '0.000100' }], ...(after ? { afterANodeDidNotAnswer: after } : {}) });
      return reply({ tasks: [] });
    })).result.content[0].text as string;
    assert.match(await withSkips({ answers: 2, nodes: 3 }), /last 24h by model:\nllama-3\.3-70b: 5 answers, \$0\.000100\n2 of these answers came from the next node after another did not answer \(3 skipped in all\)\. A node that does not answer is signed nothing\.$/);
    assert.ok(!/did not answer/.test(await withSkips({ answers: 0, nodes: 0 })));
    assert.ok(!/did not answer/.test(await withSkips(null)));
    const finished = (await call('status', {}, async (url) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0.000100', channels: [], providers: [] });
      if (url.includes('/orrery/spend')) return reply({ rows: [{ key: 'llama-3.3-70b', answers: 5, usd: '0.000100' }], afterANodeDidNotAnswer: { answers: 0, nodes: 0 }, finishedByAnotherNode: 1 });
      return reply({ tasks: [] });
    })).result.content[0].text as string;
    assert.match(finished, /\n1 of these answers was finished by another node after the first stopped mid-answer\. A node that does not finish an answer is signed nothing for it\.$/);
  });

  it('status lists the tasks with what each has left', async () => {
    const out = await call('status', {}, async (url) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0.000046', channels: [], providers: [] });
      if (url.endsWith('/orrery/tasks')) return reply({ tasks: [{ name: 'review', budget: '0.000050', spent: '0.000046', left: '0.000004', answers: 2 }, { name: 'docs', budget: '0.010000', spent: '0.000000', left: '0.010000', answers: 0 }] });
      return reply({ rows: [] });
    });
    assert.match(out.result.content[0].text, /\ntasks:\nreview: \$0\.000046 of \$0\.000050 spent, \$0\.000004 left, 2 answers\ndocs: \$0\.000000 of \$0\.010000 spent, \$0\.010000 left, 0 answers/);
  });

  it('tells the agent how what it paid compares with the node’s listed prices', async () => {
    const said = async (billed: string, listed: string, cost: string) => (await call('ask', { model: 'm', prompt: 'hi' }, async () => reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-cost': cost, 'x-orrery-billed': billed, 'x-orrery-listed': listed }))).result.content[0].text;
    assert.match(await said('0.000019', '0.000019', '0.000019'), /paid \$0\.000019 for this answer, what its listed prices come to\n/);
    assert.match(await said('0.000012', '0.000015', '0.000012'), /paid \$0\.000012 for this answer, under its listed \$0\.000015\n/);
    assert.match(await said('0.000020', '0.000015', '0.000015'), /paid \$0\.000015 for this answer \(it asked \$0\.000020; paid its listed price\)\n/);
  });

  it('status tells an agent how many requests no node answered, and that nothing was paid for them', async () => {
    const withUnanswered = async (unanswered: unknown) => (await call('status', {}, async (url) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0.000100', channels: [], providers: [] });
      if (url.includes('/orrery/spend')) return reply({ rows: [{ key: 'llama-3.3-70b', answers: 5, usd: '0.000100' }], ...(unanswered ? { unanswered } : {}) });
      return reply({ tasks: [] });
    })).result.content[0].text as string;
    assert.match(await withUnanswered({ requests: 2, nodes: 3 }), /last 24h by model:\nllama-3\.3-70b: 5 answers, \$0\.000100\n2 requests got no answer from any node asked \(3 nodes asked in all\); nothing was signed or paid for them\.$/);
    assert.ok(!/got no answer/.test(await withUnanswered({ requests: 0, nodes: 0 })));
    assert.ok(!/got no answer/.test(await withUnanswered(null)));
  });

  it('ask and embed wait up to 30 s for a node that is restarting, unless the agent asks for less', async () => {
    const sent: (string | undefined)[] = [];
    const fetchFn = async (url: string, init?: unknown) => { sent.push(((init as { headers?: Record<string, string> } | undefined)?.headers ?? {})['x-orrery-patience']); return url.includes('/embeddings') ? reply({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1 } }, 200, { 'x-orrery-cost': '0.000001' }) : reply({ choices: [{ message: { content: 'Hi.' } }] }, 200, { 'x-orrery-cost': '0.000001' }); };
    await call('ask', { model: 'm', prompt: 'hi' }, fetchFn as never);
    await call('ask', { model: 'm', prompt: 'hi', patience: 0 }, fetchFn as never);
    await call('ask', { model: 'm', prompt: 'hi', patience: 90 }, fetchFn as never);
    await call('embed', { model: 'e', input: 'hi' }, fetchFn as never);
    assert.deepEqual(sent, ['30', '0', '30', '30']);
  });

  it('ask asks once more when no node answered within its patience, since a restart can outlast one wait', async () => {
    let calls = 0;
    const away = async () => { calls++; return calls === 1 ? reply({ error: { code: 'all_failed', message: 'all providers failed: Seed: provider answered 502' } }, 502) : reply({ choices: [{ message: { content: 'Back.' } }] }, 200, { 'x-orrery-cost': '0.000010' }); };
    const out = await call('ask', { model: 'm', prompt: 'hi' }, away as never);
    assert.equal(calls, 2);
    assert.match(out.result.content[0].text, /^Back\./);
    calls = 0;
    const quick = await call('ask', { model: 'm', prompt: 'hi', patience: 0 }, away as never);
    assert.equal(calls, 1);
    assert.equal(quick.result.isError, true);
  });

  it('embed works under a task as ask does: its budget, a cost cap, one node, and what the task has left', async () => {
    const sent: Record<string, string>[] = [];
    const fetchFn = async (url: string, init?: unknown) => {
      if (url.endsWith('/orrery/status')) return reply({ providers: [{ address: 'SeedAddress111', name: 'Orrery Seed' }] });
      sent.push((init as { headers: Record<string, string> }).headers);
      return reply({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } }, 200, { 'x-orrery-cost': '0.000001', 'x-orrery-task-spent': '0.000001', 'x-orrery-task-left': '0.049999', 'x-orrery-provider': 'SeedAddress111', 'x-orrery-provider-name': 'Orrery%20Seed' });
    };
    const out = await call('embed', { model: 'e', input: 'hi', task: 'index', task_budget: 0.05, max_cost: 0.001, node: 'orrery seed' }, fetchFn as never);
    assert.equal(sent[0]['x-orrery-task'], 'index');
    assert.equal(sent[0]['x-orrery-task-budget'], '0.05');
    assert.equal(sent[0]['x-orrery-max-cost'], '0.001');
    assert.equal(sent[0]['x-orrery-provider'], 'SeedAddress111');
    assert.ok(out.result.content[0].text.endsWith('\n\n— 1 vector of 2 dimensions, 3 input tokens, paid $0.000001, answered by Orrery Seed (SeedAd…)\n— task index: $0.000001 spent, $0.049999 left'), out.result.content[0].text);
  });

  it('embed says what the task has left when the router refuses it, and names the nodes it knows when asked for another', async () => {
    const over = async () => reply({ error: { code: 'task_budget', message: 'task index has spent its budget' } }, 402, { 'x-orrery-task-spent': '0.050000', 'x-orrery-task-left': '0.000000' });
    const refused = await call('embed', { model: 'e', input: 'hi', task: 'index' }, over as never);
    assert.equal(refused.result.isError, true);
    assert.equal(refused.result.content[0].text, 'the router could not answer: task index has spent its budget\n— task index: $0.050000 spent, $0.000000 left');
    const listed = async () => reply({ providers: [{ address: 'SeedAddress111', name: 'Orrery Seed' }] });
    const unknown = await call('embed', { model: 'e', input: 'hi', node: 'nobody' }, listed as never);
    assert.equal(unknown.result.isError, true);
    assert.equal(unknown.result.content[0].text, 'no node named nobody is listed. The router knows: Orrery Seed');
  });

  it('embed asks once more when no node answered within its patience, unless the agent asked not to wait', async () => {
    let calls = 0;
    const away = async () => { calls++; return calls === 1 ? reply({ error: { code: 'all_failed', message: 'all providers failed' } }, 502) : reply({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1 } }, 200, { 'x-orrery-cost': '0.000001' }); };
    const out = await call('embed', { model: 'e', input: 'hi' }, away as never);
    assert.equal(calls, 2);
    assert.equal(out.result.isError, undefined);
    calls = 0;
    const quick = await call('embed', { model: 'e', input: 'hi', patience: 0 }, away as never);
    assert.equal(calls, 1);
    assert.equal(quick.result.isError, true);
  });

  it('embed tells an agent which of these it can pass', async () => {
    const listed = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'http://r', (async () => reply({})) as never, '0')) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } };
    const embed = listed.result.tools.find((t) => t.name === 'embed')!;
    for (const k of ['max_price', 'max_cost', 'task', 'task_budget', 'node', 'patience']) assert.ok(k in embed.inputSchema.properties, k);
  });

  it('orrery mcp --agent names every call with its agent and says what that agent has spent and has left today', async () => {
    const sent: Record<string, string>[] = [];
    const asAgent = async (name: string, args: Record<string, unknown>, answer: Reply, agent: string | null) =>
      (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, 'http://r', (async (_u: string, init?: { headers?: Record<string, string> }) => { sent.push(init?.headers ?? {}); return answer; }) as never, '0', agent)) as { result: { content: { text: string }[]; isError?: boolean } };
    const paid = reply({ choices: [{ message: { content: 'Hello.' } }] }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-cost': '0.000006', 'x-orrery-agent-spent': '0.000012', 'x-orrery-agent-left': '0.000008' });
    const out = await asAgent('ask', { model: 'm', prompt: 'hi' }, paid, 'researcher');
    assert.equal(sent.at(-1)!['x-orrery-agent'], 'researcher');
    assert.match(out.result.content[0].text, /\n— agent researcher: \$0\.000012 spent today, \$0\.000008 left$/);
    const vec = reply({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 2 } }, 200, { 'x-orrery-cost': '0.000001', 'x-orrery-agent-spent': '0.000013', 'x-orrery-agent-left': '0.000007' });
    assert.match((await asAgent('embed', { model: 'e', input: 'hi' }, vec, 'researcher')).result.content[0].text, /— agent researcher: \$0\.000013 spent today, \$0\.000007 left$/);
    assert.equal(sent.at(-1)!['x-orrery-agent'], 'researcher');
    const spent = reply({ error: { code: 'agent_cap', message: 'agent researcher has spent its $0.000020 for today (UTC); it can spend again from 00:00 UTC' } }, 402, { 'x-orrery-agent-spent': '0.000020', 'x-orrery-agent-left': '0.000000' });
    const refused = await asAgent('ask', { model: 'm', prompt: 'hi' }, spent, 'researcher');
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /— agent researcher: \$0\.000020 spent today, nothing left until 00:00 UTC$/);
    const none = await asAgent('ask', { model: 'm', prompt: 'hi' }, paid, null);
    assert.equal(sent.at(-1)!['x-orrery-agent'], undefined);
    assert.doesNotMatch(none.result.content[0].text, /— agent/);
  });

  it('status lists every agent’s day, this server’s own agent first', async () => {
    const st = { spentToday: '0.000040', channels: [], providers: [], agents: [{ name: 'coder', cap: '2.000000', spent: '0.000020', left: '1.999980' }, { name: 'researcher', cap: '0.000020', spent: '0.000020', left: '0.000000' }, { name: 'tagger', cap: null, spent: '0.000001', left: null }] };
    const fetchFn = async (url: string) => (url.endsWith('/orrery/status') ? reply(st) : reply({}));
    const text = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }, 'http://r', fetchFn as never, '0', 'researcher') as { result: { content: { text: string }[] } }).result.content[0].text;
    assert.match(text, /\nagents, today \(UTC\):\nresearcher \(this one\): \$0\.000020 spent today of \$0\.000020, nothing left until 00:00 UTC\ncoder: \$0\.000020 spent today of \$2\.000000, \$1\.999980 left\ntagger: \$0\.000001 spent today, no limit$/);
    const fresh = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }, 'http://r', (async (url: string) => (url.endsWith('/orrery/status') ? reply({ ...st, agents: [] }) : reply({}))) as never, '0', 'writer') as { result: { content: { text: string }[] } }).result.content[0].text;
    assert.match(fresh, /\nthis agent: writer, nothing spent today$/);
    const menu = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }, 'http://r', (async (url: string) => (url.endsWith('/orrery/status') ? reply({ ...st, agents: [{ name: 'coder', cap: null, spent: '0.000001', left: null, models: ['qwen3-coder-30b', 'deepseek-v3'] }] }) : reply({}))) as never, '0', 'coder') as { result: { content: { text: string }[] } }).result.content[0].text;
    assert.match(menu, /\ncoder \(this one\): \$0\.000001 spent today, no limit; may use qwen3-coder-30b, deepseek-v3$/);
  });

  it('rerank lists the documents best first with their index and score, and what it paid; it says what it needs', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const fetchFn = async (url: string, init?: { body?: string }) => { sent = { url, body: JSON.parse(init?.body ?? '{}') }; return reply({ results: [{ index: 2, relevance_score: 0.428571 }, { index: 0, relevance_score: 0.1 }], usage: { total_tokens: 49 } }, 200, { 'x-orrery-provider': '76UdbaSy69', 'x-orrery-provider-name': 'Orrery Seed', 'x-orrery-cost': '0.000001' }); };
    const out = await call('rerank', { model: 'r', query: 'q', documents: ['a  first', 'b', 'c third'], top_n: 2 }, fetchFn as never);
    assert.equal(sent!.url, 'http://r/v1/rerank');
    assert.deepEqual(sent!.body, { model: 'r', query: 'q', documents: ['a  first', 'b', 'c third'], top_n: 2 });
    assert.equal(out.result.content[0].text, '1. [2] 0.4286  c third\n2. [0] 0.1000  a first\n\n— 2 of 3 documents ranked, 49 input tokens, paid $0.000001, answered by Orrery Seed (76Udba…)');
    const missing = await call('rerank', { model: 'r', query: 'q', documents: [] }, fetchFn as never);
    assert.equal(missing.result.isError, true);
    assert.equal(missing.result.content[0].text, 'rerank needs a model, a query and a list of documents');
  });
});
