import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bytesText, byTrust, fullRelaysText, holderLaneLine, newer, peerCheck, peerLine, peersReport, peersSummary, relayChoices, relayLine, render, routerBehind, versionCheck } from '../src/doctor.ts';
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

  it('says a router met through a peer, and which peer introduced it', () => {
    const by = '5dKxViAbCdEfGhJkLmNoPqRsTuVwXyZ123456789ab';
    assert.equal(peerLine({ url: 'http://10.0.0.6:7171', pinned: true, by, signed: true, nodes: 3, refused: null, at: 1, missed: 0, via: 'http://10.0.0.2:7171' }), 'http://10.0.0.6:7171: signed by 5dKx\u202689ab (pinned), notes on 3 nodes, met through http://10.0.0.2:7171');
    assert.equal(peerLine({ url: 'http://10.0.0.6:7171', pinned: true, by: null, signed: false, nodes: 0, refused: 'the signature does not match the notes', via: 'http://10.0.0.2:7171' }), 'http://10.0.0.6:7171: refused, the signature does not match the notes, met through http://10.0.0.2:7171');
  });

  it('says when a peer that keeps missing is read next', () => {
    const now = 1_000_000;
    assert.equal(peerLine({ url: 'http://10.0.0.5:7171', pinned: false, by: null, signed: false, nodes: 0, refused: null, at: 0, missed: 4, retryAt: now + 110_000 }, now), 'http://10.0.0.5:7171: no answer yet (4 reads tried; next read in 2 min)');
    assert.equal(peerLine({ url: 'http://10.0.0.5:7171', pinned: false, by: null, signed: false, nodes: 0, refused: null, at: 0, missed: 3, retryAt: now - 1 }, now), 'http://10.0.0.5:7171: no answer yet (3 reads tried)');
  });

  it('says when a peer runs a relay this router could use as its proxy', () => {
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: 1, missed: 0, relayPort: 7272 }), 'http://10.0.0.2:7171: unsigned, notes on 2 nodes; relays on port 7272, usable as --proxy http://<its host>:7272');
  });

  it('orrery peers: counts the peer routers, a line for each, the router\'s own relay, and how to start when there are none', () => {
    const by = '5dKxViAbCdEfGhJkLmNoPqRsTuVwXyZ123456789ab';
    assert.deepEqual(peersReport({ peers: [], relay: null }), [
      'This router reads no peer routers. Start it with --peer <url>#<key> to read another router\u2019s notes on nodes, and --meet-peers to meet the routers that one reads.',
      'this router runs no relay (start it with --relay <port> to carry other routers\u2019 traffic to listed nodes)',
    ]);
    assert.deepEqual(peersReport({
      peers: [
        { url: 'http://10.0.0.2:7171', pinned: true, by, signed: true, nodes: 4, refused: null, at: 1, missed: 0, relayPort: 7272 },
        { url: 'http://10.0.0.6:7171', pinned: true, by, signed: true, nodes: 3, refused: null, at: 1, missed: 0, via: 'http://10.0.0.2:7171' },
        { url: 'http://10.0.0.7:7171', pinned: true, by: null, signed: false, nodes: 0, refused: 'the signature does not match the notes', via: 'http://10.0.0.2:7171' },
      ],
      relay: { port: 7272, relayed: 9, refused: 1, open: 2, perClient: 16 },
      discovery: 'peers',
    }), [
      '3 peer routers: 2 signed, 2 met through a peer, 1 refused, 1 relaying',
      '  http://10.0.0.2:7171: signed by 5dKx\u202689ab (pinned), notes on 4 nodes; relays on port 7272, usable as --proxy http://<its host>:7272',
      '  http://10.0.0.6:7171: signed by 5dKx\u202689ab (pinned), notes on 3 nodes, met through http://10.0.0.2:7171',
      '  http://10.0.0.7:7171: refused, the signature does not match the notes, met through http://10.0.0.2:7171',
      'this router\'s relay: open on port 7272: carried 9, refused 1, 2 open now (up to 16 at a time for one address) (listed nodes only)',
      'the listings came from the peers\u2019 notes, each checked on chain',
    ]);
  });

  it('says how many of a peer\'s nodes are not listed on chain, which this router does not use', () => {
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 5, refused: null, at: 1, missed: 0, unlisted: 1 }), 'http://10.0.0.2:7171: unsigned, notes on 5 nodes, 1 of them not listed on chain (not used)');
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 5, refused: null, at: 1, missed: 0, unlisted: 0 }), 'http://10.0.0.2:7171: unsigned, notes on 5 nodes');
  });

  it('says how many connections a peer\'s relay has open, when it says', () => {
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: 1, missed: 0, relayPort: 7272, relayOpen: 3 }), 'http://10.0.0.2:7171: unsigned, notes on 2 nodes; relays on port 7272 (3 open now), usable as --proxy http://<its host>:7272');
  });

  it('orrery peers puts the given and answering first and the refused last, and counts them for --json', () => {
    const base = { pinned: false, by: null, signed: false, nodes: 1, refused: null as string | null, at: 1, missed: 0 };
    const rows = [
      { ...base, url: 'refused', refused: 'the signature does not match the notes' },
      { ...base, url: 'never', at: 0, missed: 2 },
      { ...base, url: 'met', signed: true, via: 'given' },
      { ...base, url: 'quiet', signed: true, missed: 1 },
      { ...base, url: 'unsigned' },
      { ...base, url: 'given', signed: true, relayPort: 7272 },
    ];
    assert.deepEqual(byTrust(rows).map((p) => p.url), ['given', 'unsigned', 'met', 'quiet', 'never', 'refused']);
    assert.deepEqual(peersSummary(rows), { peers: 6, signed: 3, met: 1, refused: 1, relaying: 1 });
  });

  it('orrery peers --check says what this router would make of a router before it is added', () => {
    assert.deepEqual(peerCheck('http://10.0.0.9:7171', 'connect ECONNREFUSED'), { ok: false, lines: ['http://10.0.0.9:7171: no notes (connect ECONNREFUSED); a router shares them only when started with --share-notes'] });
    const now = 10_000_000_000;
    const unsigned = { notes: 1, at: now - 12_000, nodes: [] };
    assert.deepEqual(peerCheck('http://10.0.0.9:7171/', unsigned, null, now), { ok: true, lines: [
      'http://10.0.0.9:7171: answers, unsigned, notes on 0 nodes, written 12 s ago',
      'unsigned: shown beside your record, but --trust-peers will not count them',
      'runs no relay',
      'introduces no routers (no /orrery/peers)',
      'add it with: --peer http://10.0.0.9:7171 (unsigned, so it cannot be pinned)',
    ] });
    assert.deepEqual(peerCheck('http://10.0.0.9:7171', { notes: 1, at: now - 3 * 3_600_000, nodes: [] }, null, now), { ok: false, lines: ['http://10.0.0.9:7171: its notes would be refused: the notes are 180 min old; older than an hour is not used'] });
  });

  it('peersReport and doctor share one summary line', () => {
    const rows = [{ url: 'http://10.0.0.2:7171', pinned: true, by: '5dKxViAbCdEfGhJkLmNoPqRsTuVwXyZ123456789ab', signed: true, nodes: 4, refused: null, at: 1, missed: 0, relayPort: 7272 }];
    assert.equal(peersReport({ peers: rows, relay: null })[0], '1 peer router: 1 signed, 0 met through a peer, 0 refused, 1 relaying');
  });

  it('puts a peer\'s name from the peers file before its address', () => {
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: 1, missed: 0, name: 'alice' }), 'alice (http://10.0.0.2:7171): unsigned, notes on 2 nodes');
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 0, refused: 'the signature does not match the notes', name: 'alice' }), 'alice (http://10.0.0.2:7171): refused, the signature does not match the notes');
  });

  it('says when a peer is counted with the notes kept from before the restart, and how old they are', () => {
    const now = 10_000_000_000;
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: now - 12 * 60_000, missed: 1, kept: true }, now),
      'http://10.0.0.2:7171: unsigned, notes on 2 nodes, kept from before the restart (written 12 min ago); no answer to the last read, these notes are kept for up to an hour');
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: now, missed: 0, kept: false }, now), 'http://10.0.0.2:7171: unsigned, notes on 2 nodes');
  });

  it('says how much a peer counts under --trust-peers when it is less than in full, and how old its notes are', () => {
    const now = 10_000_000_000;
    const by = '5dKxQ9vT2m8sJ3hP7nL4wR6yB1cF0aE89ab';
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: true, by, signed: true, nodes: 3, refused: null, at: now, missed: 0, say: 0.5, written: now - 35 * 60_000 }, now),
      'http://10.0.0.2:7171: signed by 5dKx\u202689ab (pinned), notes on 3 nodes; counts 50% under --trust-peers (notes 35 min old)');
    assert.equal(peerLine({ url: 'http://10.0.0.6:7171', pinned: true, by, signed: true, nodes: 3, refused: null, at: now, missed: 0, via: 'http://10.0.0.2:7171', say: 0.5, written: now - 60_000 }, now),
      'http://10.0.0.6:7171: signed by 5dKx\u202689ab (pinned), notes on 3 nodes, met through http://10.0.0.2:7171; counts 50% under --trust-peers');
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: true, by, signed: true, nodes: 3, refused: null, at: now, missed: 0, say: 1, written: now }, now), 'http://10.0.0.2:7171: signed by 5dKx\u202689ab (pinned), notes on 3 nodes');
  });

  it('says how many bytes the relay carried for other routers, when it carried any', () => {
    assert.deepEqual([bytesText(0), bytesText(1023), bytesText(1536), bytesText(12 * 1024 ** 2), bytesText(1.25 * 1024 ** 3)], ['0 B', '1023 B', '1.5 KB', '12.0 MB', '1.25 GB']);
    assert.equal(relayLine({ port: 7272, relayed: 31, refused: 4, open: 3, perClient: 16, bytes: 3_565_158 }), 'open on port 7272: carried 31 (3.4 MB), refused 4, 3 open now (up to 16 at a time for one address) (listed nodes only)');
    assert.equal(relayLine({ port: 7272, relayed: 0, refused: 0, bytes: 0 }), 'open on port 7272: carried 0, refused 0 (listed nodes only)');
  });

  it('says how much of the relay\'s daily limit it has carried today, when it has one', () => {
    assert.equal(relayLine({ port: 7272, relayed: 31, refused: 4, bytes: 3_565_158, today: 3_565_158, maxBytes: 500 * 1024 ** 2 }), 'open on port 7272: carried 31 (3.4 MB), refused 4, 3.4 MB of 500.0 MB today (listed nodes only)');
  });

  it('says when a peer\'s relay is full for today, in its line and before it is added', () => {
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: 1, missed: 0, relayPort: 7272, relayOpen: 0, relayFull: true }),
      'http://10.0.0.2:7171: unsigned, notes on 2 nodes; relays on port 7272 (0 open now, full for today), usable as --proxy http://<its host>:7272');
    const now = 10_000_000_000;
    assert.equal(peerCheck('http://10.0.0.9:7171', { notes: 1, at: now, nodes: [] }, { peers: [], relay: { port: 7272, full: true } }, now).lines[2], 'relays on port 7272 (full for today), usable as --proxy http://<its host>:7272');
  });

  it('heads the peers with how many of their relays are full for today, when any is', () => {
    const row = { url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 0, refused: null, at: 1, missed: 0, relayPort: 7272, relayOpen: 0 };
    assert.equal(fullRelaysText([row]), '');
    assert.equal(fullRelaysText([{ ...row, relayFull: true }, { ...row, url: 'http://10.0.0.3:7171', relayFull: true }]), ' (2 full for today)');
    assert.equal(peersReport({ peers: [{ ...row, relayFull: true }], relay: null })[0], '1 peer router: 0 signed, 0 met through a peer, 0 refused, 1 relaying (1 full for today)');
  });

  it('lists the peers\' relays as --proxy lines, least busy first, leaving out the full ones and the peers that never answered', () => {
    const row = { pinned: false, by: null, signed: true, nodes: 0, refused: null, at: 1, missed: 0 };
    assert.deepEqual(relayChoices([{ ...row, url: 'http://10.0.0.2:7171' }]), ['No peer offers a relay yet. A peer started with --relay <port> offers one; until then your router reaches the nodes itself (or through your own --proxy).']);
    assert.deepEqual(relayChoices([
      { ...row, url: 'http://10.0.0.2:7171', name: 'alice', relayPort: 7272, relayOpen: 3 },
      { ...row, url: 'http://10.0.0.3:7171', via: 'http://10.0.0.2:7171', relayPort: 7373, relayOpen: 0, signed: false },
      { ...row, url: 'http://10.0.0.4:7171', relayPort: 7474, relayOpen: 0, relayFull: true },
      { ...row, url: 'http://10.0.0.5:7171', relayPort: 7575, at: 0 },
      { ...row, url: 'http://10.0.0.6:7171', relayPort: 7676, refused: 'not notes' },
    ]), [
      '2 peer relays you can use, least busy first:',
      '  --proxy http://10.0.0.3:7373  (http://10.0.0.3:7171, met through http://10.0.0.2:7171, 0 open now, unsigned)',
      '  --proxy http://10.0.0.2:7272  (alice, 3 open now)',
      '1 full for today, left out: http://10.0.0.4:7171',
      'Start your router with one as --proxy and the nodes see that router, not this computer.',
    ]);
    assert.deepEqual(relayChoices([{ ...row, url: 'http://10.0.0.4:7171', relayPort: 7474, relayFull: true }]), ['No peer relay can take new connections right now.', '1 full for today, left out: http://10.0.0.4:7171']);
  });

  it('says when a full relay still carries $OREY holders, and how many it carried past its limit', () => {
    assert.equal(peerLine({ url: 'http://10.0.0.2:7171', pinned: false, by: null, signed: false, nodes: 2, refused: null, at: 1, missed: 0, relayPort: 7272, relayOpen: 0, relayFull: true, relayHolders: true }),
      'http://10.0.0.2:7171: unsigned, notes on 2 nodes; relays on port 7272 (0 open now, full for today, $OREY holders still ride), usable as --proxy http://<its host>:7272');
    assert.equal(relayLine({ port: 7272, relayed: 31, refused: 4, bytes: 3_565_158, today: 3_565_158, maxBytes: 1024 ** 2, forHolders: 3 }), 'open on port 7272: carried 31 (3.4 MB), refused 4, 3.4 MB of 1.0 MB today, 3 carried for $OREY holders past it (listed nodes only)');
  });

  it('says whether this router\'s wallet rides the holder lanes on peer relays, and the share that does', () => {
    assert.equal(holderLaneLine(true, '2.00%'), 'this wallet holds 2.00% of $OREY, past the 0.01% that rides holder lanes: peer relays that carry holders take it past their daily limit (--proxy-via-peers)');
    assert.equal(holderLaneLine(false, '0.0040%'), "0.01% of $OREY's supply (100k) rides holder lanes on peer relays past their daily limit; this wallet holds 0.0040%");
  });

  it('offers a full relay that still carries holders to a router whose wallet rides the holder lanes, and only to it', () => {
    const row = { pinned: false, by: null, signed: true, nodes: 0, refused: null, at: 1, missed: 0 };
    const peers = [
      { ...row, url: 'http://10.0.0.2:7171', relayPort: 7272, relayOpen: 0, relayFull: true, relayHolders: true },
      { ...row, url: 'http://10.0.0.3:7171', relayPort: 7373, relayOpen: 0, relayFull: true },
    ];
    assert.deepEqual(relayChoices(peers, true), [
      '1 peer relay you can use, least busy first:',
      '  --proxy http://10.0.0.2:7272  (http://10.0.0.2:7171, 0 open now, full for today, carries you as a $OREY holder)',
      '1 full for today, left out: http://10.0.0.3:7171',
      'Start your router with one as --proxy and the nodes see that router, not this computer.',
    ]);
    assert.deepEqual(relayChoices(peers, false), ['No peer relay can take new connections right now.', '2 full for today, left out: http://10.0.0.2:7171, http://10.0.0.3:7171']);
  });

  it('orrery peers --check says when a router\'s relay keeps a lane for $OREY holders, full for today or not', () => {
    const now = 10_000_000_000;
    const notes = { notes: 1, at: now, nodes: [] };
    assert.equal(peerCheck('http://10.0.0.9:7171', notes, { peers: [], relay: { port: 7272, open: 1, holders: true } }, now).lines[2], 'relays on port 7272 (1 open now, keeps a lane for $OREY holders past its daily limit), usable as --proxy http://<its host>:7272');
    assert.equal(peerCheck('http://10.0.0.9:7171', notes, { peers: [], relay: { port: 7272, open: 0, full: true, holders: true } }, now).lines[2], 'relays on port 7272 (0 open now, full for today, $OREY holders still ride), usable as --proxy http://<its host>:7272');
  });
});
