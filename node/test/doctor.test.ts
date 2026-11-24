import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newer, peerLine, relayLine, render, routerBehind, versionCheck } from '../src/doctor.ts';
import { agentDayLine, keptLine, paidLine } from '../src/doctor.ts';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('orrery doctor version line', () => {
  it('compares dotted versions', () => {
    assert.ok(newer('0.1.4', '0.1.5'));
    assert.ok(newer('0.1.9', '0.2.0'));
    assert.ok(!newer('0.1.5', '0.1.5'));
    assert.ok(!newer('0.1.10', '0.1.9'));
  });

  it('points to the newer release, or says this one is current', () => {
    assert.match(render([versionCheck('0.1.4', '0.1.5')]), /· version\s+0\.1\.4; 0\.1\.5 is on npm: npx -y orrery-node@latest/);
    assert.match(render([versionCheck('0.1.5', '0.1.5')]), /✓ version\s+0\.1\.5, the latest on npm/);
    assert.match(render([versionCheck('0.1.5', null)]), /· version\s+0\.1\.5; npm did not answer/);
    assert.match(render([versionCheck('0.1.5', '0.1.4')]), /✓ version\s+0\.1\.5, ahead of npm \(0\.1\.4\)/);
  });
});

describe('orrery doctor, what the running router paid', () => {
  it('says what the last 24 hours cost, by the router’s own log', () => {
    assert.equal(paidLine({ total: { answers: 6, usd: '0.000192' } }), '$0.000192 for 6 answers in the last 24 h');
    assert.equal(paidLine({ total: { answers: 1, usd: '0.000014' } }), '$0.000014 for 1 answer in the last 24 h');
    assert.equal(paidLine({ total: { answers: 0, usd: '0.000000' } }), 'nothing in the last 24 h');
  });

  it('adds what it did not pay for: a node that did not answer, or did not finish', () => {
    assert.equal(paidLine({ total: { answers: 41, usd: '0.000700' }, afterANodeDidNotAnswer: { answers: 2, nodes: 3 }, finishedByAnotherNode: 1 }),
      '$0.000700 for 41 answers in the last 24 h · 2 of these answers came from the next node after another did not answer (3 skipped in all); 1 was finished by another node after the first stopped mid-answer. A node that does not answer or does not finish is signed nothing.');
    assert.equal(paidLine({ total: { answers: 41, usd: '0.000700' }, afterANodeDidNotAnswer: { answers: 0, nodes: 0 }, finishedByAnotherNode: 0 }), '$0.000700 for 41 answers in the last 24 h');
    assert.equal(paidLine(null), null);
    assert.equal(paidLine({}), null);
  });

  it('gives each node the speed this router measured for itself', async () => {
    const { speedLines } = await import('../src/doctor.ts');
    assert.deepEqual(speedLines({ speed: [{ provider: 'a', name: 'Orrery Seed', answers: 42, medianTtftMs: 934 }, { provider: 'b', name: 'Vault Nine', answers: 1, medianTtftMs: 120 }] }), [
      'Orrery Seed started answering in 934 ms (median of 42 answers in the last 24 h)',
      'Vault Nine started answering in 120 ms (1 answer in the last 24 h)',
    ]);
    assert.deepEqual(speedLines({ total: { answers: 3, usd: '0.000001' } }), []);
    assert.deepEqual(speedLines(null), []);
  });

  it('says how to start a router the way it starts now: no --wallet for the wallet in the home folder, wallet new first when there is none', async () => {
    const { routerMissing } = await import('../src/doctor.ts');
    assert.equal(routerMissing('http://127.0.0.1:7171', true), 'not running at http://127.0.0.1:7171; start it with orrery router');
    assert.equal(routerMissing('http://127.0.0.1:7171', false), 'not running at http://127.0.0.1:7171; start it with orrery wallet new   (makes the wallet that pays; send it SOL and USDC), then orrery router');
  });

  it('gives each node what this router found when it checked its bills against the prices it listed', async () => {
    const d = (await import('../src/doctor.ts')) as unknown as { billsLines?: (sp: unknown) => string[] };
    assert.equal(typeof d.billsLines, 'function', 'doctor prints the bills record');
    assert.deepEqual(d.billsLines!({ bills: [{ provider: 'a', name: 'Orrery Seed', checked: 42, over: 0 }, { provider: 'b', name: 'Vault Nine', checked: 3, over: 1 }] }), [
      'Orrery Seed every bill was within its listed prices (42 answers in the last 24 h)',
      'Vault Nine billed above its listed prices in 1 of 3 answers in the last 24 h; this router paid no more than those prices',
    ]);
    assert.deepEqual(d.billsLines!(null), []);
  });

  it('the paid line also says how many requests no node answered, and that nothing was paid for them', () => {
    assert.equal(paidLine({ total: { answers: 6, usd: '0.000192' }, unanswered: { requests: 2, nodes: 3 } } as Parameters<typeof paidLine>[0]), '$0.000192 for 6 answers in the last 24 h · 2 requests got no answer from any node asked (3 nodes asked in all); nothing was signed or paid for them.');
    assert.equal(paidLine({ total: { answers: 0, usd: '0.000000' }, unanswered: { requests: 1, nodes: 1 } } as Parameters<typeof paidLine>[0]), 'nothing in the last 24 h · 1 request got no answer from the node asked; nothing was signed or paid for it.');
    assert.equal(paidLine({ total: { answers: 6, usd: '0.000192' }, unanswered: { requests: 0, nodes: 0 } } as Parameters<typeof paidLine>[0]), '$0.000192 for 6 answers in the last 24 h');
  });

  it('says what the router keeps on this computer, and that no prompt or answer is in it', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'orrery-kept-')), 'router');
    mkdirSync(dir, { recursive: true });
    const trip = { at: 1, model: 'm', provider: 'P', providerName: 'p', inputTokens: 1, outputTokens: 1, cost: '0.000001' };
    writeFileSync(join(dir, 'trips.jsonl'), `${JSON.stringify(trip)}\n${JSON.stringify(trip)}\n`);
    writeFileSync(join(dir, 'unanswered.jsonl'), `${JSON.stringify({ at: 1, model: 'm', asked: 1 })}\n`);
    writeFileSync(join(dir, 'observed.json'), JSON.stringify({ A: { ok: 1, fail: 0, ttftMs: 9, at: 1 }, B: { ok: 0, fail: 1, ttftMs: null, at: 1 } }));
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({ channels: [{ provider: 'A' }], spend: { day: '2026-11-17', units: '0' } }));
    assert.deepEqual(keptLine(dir), { ok: null, what: 'kept here', detail: `${dir}: 2 answers, 1 unanswered request, a record of 2 nodes, 1 channel · models, token counts, prices and timings, never a prompt or an answer` });
    assert.equal(keptLine(join(dir, 'nowhere')), null);
  });

  it('says an agent’s day: its limit, what it spent and has left, and the models it is kept to', () => {
    assert.equal(agentDayLine({ name: 'researcher', cap: '0.000020', spent: '0.000018', left: '0.000002', models: ['llama-3.3-70b'] }), 'researcher: $0.000018 of $0.000020 spent today (UTC), $0.000002 left; may use llama-3.3-70b');
    assert.equal(agentDayLine({ name: 'coder', cap: '2.000000', spent: '2.000000', left: '0.000000' }), 'coder: $2.000000 of $2.000000 spent today (UTC), nothing left until 00:00 UTC');
    assert.equal(agentDayLine({ name: 'writer', cap: null, spent: '0.000012', left: null }), 'writer: $0.000012 spent today (UTC), no limit');
  });

  it('says when the running router is older than the release installed here, without asking npm', () => {
    assert.equal(routerBehind('0.1.26', '0.1.27'), '0.1.26 is running; 0.1.27 is installed here: stop the router and start it again to run 0.1.27');
    assert.equal(routerBehind('0.1.27', '0.1.27'), null);
    assert.equal(routerBehind('0.1.28', '0.1.27'), null);
    assert.equal(routerBehind(null, '0.1.27'), null);
    assert.equal(routerBehind('0.1.26', null), null);
  });

  it('says each peer router: who signed its notes and on how many nodes, or why they were refused', () => {
    const by = '5dKxViAbCdEfGhJkLmNoPqRsTuVwXyZ123456789ab';
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: true, by, signed: true, nodes: 4, refused: null }), 'http://10.0.0.2:7171: signed by 5dKx\u202689ab (pinned), notes on 4 nodes');
    assert.equal(peerLine({ url: 'http://10.0.0.3:7171', pinned: false, by: null, signed: false, nodes: 1, refused: null }), 'http://10.0.0.3:7171: unsigned, notes on 1 node');
    assert.equal(peerLine({ url: 'http://10.0.0.4:7171', pinned: false, by: null, signed: false, nodes: 0, refused: 'the signature does not match the notes' }), 'http://10.0.0.4:7171: refused, the signature does not match the notes');
  });

  it('says the relay: what it carried and refused, and the connections open now against the limit for one address', () => {
    assert.equal(relayLine({ port: 7272, relayed: 31, refused: 4, open: 3, perClient: 16 }), 'open on port 7272: carried 31, refused 4, 3 open now (up to 16 at a time for one address) (listed nodes only)');
    assert.equal(relayLine({ port: 7272, relayed: 2, refused: 0 }), 'open on port 7272: carried 2, refused 0 (listed nodes only)');
  });

  it('says a peer that does not answer: one that never has, with the reads tried, and one that went quiet, with its notes kept', () => {
    const by = '5dKxViAbCdEfGhJkLmNoPqRsTuVwXyZ123456789ab';
    assert.equal(peerLine({ url: 'http://10.0.0.5:7171', pinned: false, by: null, signed: false, nodes: 0, refused: null, at: 0, missed: 3 }), 'http://10.0.0.5:7171: no answer yet (3 reads tried)');
    assert.equal(peerLine({ url: 'http://10.0.0.5:7171', pinned: false, by: null, signed: false, nodes: 0, refused: null, at: 0, missed: 1 }), 'http://10.0.0.5:7171: no answer yet (1 read tried)');
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: true, by, signed: true, nodes: 4, refused: null, at: 1, missed: 2 }), 'http://10.0.0.2:7171: signed by 5dKx\u202689ab (pinned), notes on 4 nodes; no answer to the last 2 reads, these notes are kept for up to an hour');
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: true, by, signed: true, nodes: 4, refused: null, at: 1, missed: 0 }), 'http://10.0.0.2:7171: signed by 5dKx\u202689ab (pinned), notes on 4 nodes');
  });
});
