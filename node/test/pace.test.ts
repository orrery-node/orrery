import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { frameMsFrom, Pacer, PACED_BLOCK, paceFrom } from '../src/provider/pace.ts';
import { padFrame } from '../src/seal.ts';
import { paceClause, privacySentence } from '../src/privacy.ts';
import { appendTrip, pacedAnswers, readTrips } from '../src/spend.ts';
import { dayLine, pacedSentence, providerConsolePage } from '../src/provider/console.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('paced answer frames', () => {
  it('sends the first chunk at once, then one frame a beat holding what came in, or nothing', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const out: unknown[][] = [];
    const p = new Pacer(100, (f) => out.push(JSON.parse(f) as unknown[]));
    p.push({ n: 1 });
    assert.deepEqual(out, [[{ n: 1 }]]);
    p.push({ n: 2 });
    p.push({ n: 3 });
    t.mock.timers.tick(100);
    assert.deepEqual(out.at(-1), [{ n: 2 }, { n: 3 }]);
    t.mock.timers.tick(100);
    assert.deepEqual(out.at(-1), [], 'a beat with nothing new still sends a frame');
    p.push({ n: 4 });
    p.end();
    assert.deepEqual(out.at(-1), [{ n: 4 }]);
    const sent = out.length;
    t.mock.timers.tick(500);
    assert.equal(out.length, sent, 'nothing after the end');
  });

  it('stop sends nothing more', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const out: string[] = [];
    const p = new Pacer(50, (f) => out.push(f));
    p.push({ n: 1 });
    p.push({ n: 2 });
    p.stop();
    t.mock.timers.tick(200);
    assert.deepEqual(out, ['[{"n":1}]']);
  });

  it('takes a pace from 20 ms to a second, and nothing else', () => {
    assert.equal(paceFrom('100'), 100);
    assert.equal(paceFrom(['250']), 250);
    for (const bad of [undefined, '', '0', '5', '1001', 'fast', '-100']) assert.equal(paceFrom(bad), null, String(bad));
  });

  it('pads a paced frame to whole 4 KiB blocks, so a beat with one token and one with twelve look the same', () => {
    const one = JSON.stringify([{ choices: [{ delta: { content: 'a' } }] }]);
    const twelve = JSON.stringify(Array.from({ length: 12 }, () => ({ id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: ' token' } }] })));
    assert.equal(padFrame(one, PACED_BLOCK).length, PACED_BLOCK);
    assert.equal(padFrame(twelve, PACED_BLOCK).length, padFrame(one, PACED_BLOCK).length);
    assert.deepEqual(JSON.parse(padFrame(twelve, PACED_BLOCK).toString('utf8')), JSON.parse(twelve));
  });
});

describe('the privacy line says how sealed answers come back', () => {
  it('names the beat, and how many nodes that answered sealed paced their answers', () => {
    assert.equal(paceClause({ ms: 100, paced: 0, asked: 0 }), 'sealed answers are asked for one 4 KiB frame every 100 ms');
    assert.equal(paceClause({ ms: 100, paced: 3, asked: 4 }), 'sealed answers are asked for one 4 KiB frame every 100 ms; 3 of 4 nodes that answered sealed paced their answers');
    assert.equal(paceClause({ ms: 250, paced: 1, asked: 1 }), 'sealed answers are asked for one 4 KiB frame every 250 ms; 1 of 1 node that answered sealed paced its answers');
    assert.equal(paceClause({ ms: 0, paced: 0, asked: 0 }), 'sealed answers come back a chunk per frame (--frame-ms turns pacing on)');
  });

  it('goes before the client IDs, and only where the router passes it', () => {
    const nodes = [{ wire: true, inside: true, enclave: false }];
    assert.ok(privacySentence(nodes, true, { ms: 100, paced: 1, asked: 1 }).endsWith(' · sealed answers are asked for one 4 KiB frame every 100 ms; 1 of 1 node that answered sealed paced its answers · client IDs are dropped before anything leaves'));
    assert.ok(!privacySentence(nodes, true).includes('frame'));
  });
});

describe('the beat a router asks for', () => {
  it('takes --frame-ms or x-orrery-frame-ms: 0 turns pacing off, 20 to 1000 ms paces, nothing given keeps the default', () => {
    assert.equal(frameMsFrom(undefined, 100), 100);
    assert.equal(frameMsFrom('0', 100), 0);
    assert.equal(frameMsFrom('250', 100), 250);
    assert.equal(frameMsFrom(['50'], 100), 50);
  });

  it('refuses a beat a node would not keep to, instead of letting it go unpaced without a word', () => {
    for (const bad of ['5', '1001', 'fast', '100.5', '-1', '']) assert.throws(() => frameMsFrom(bad, 100), /frame-ms is 0 \(off\) or whole milliseconds from 20 to 1000/, bad);
  });
});

describe('a node keeps the beat an answer went out on', () => {
  it('writes paced to its log of answers, and nothing when the answer was not paced', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'orrery-pace-')), 'served.jsonl');
    const base = { model: 'llama-3.3-70b', provider: 'x', providerName: 'x', inputTokens: 10, outputTokens: 16, cost: '0.000010' };
    appendTrip(log, { ...base, at: 1, paced: 100 });
    appendTrip(log, { ...base, at: 2 });
    assert.deepEqual(readTrips(log).map((t) => t.paced), [100, undefined]);
  });
});

describe('a node counts the answers it sent paced', () => {
  it('counts paced answers in the window, and provider status says it on the day line', () => {
    const now = 10 * 86_400_000;
    const base = { model: 'm', provider: 'x', providerName: 'x', inputTokens: 1, outputTokens: 1, cost: '0.000001' };
    const trips = [{ ...base, at: now - 1000, paced: 100 }, { ...base, at: now - 2000 }, { ...base, at: now - 90_000_000, paced: 100 }];
    assert.equal(pacedAnswers(trips, 86_400_000, now), 1);
    assert.equal(dayLine({ answers: 1312, usd: '0.038912', paced: 1040 }), '  last 24 h             1,312 answers, $0.038912 billed, 1,040 sent paced');
    assert.equal(dayLine({ answers: 2, usd: '0.000002', paced: 0 }), '  last 24 h             2 answers, $0.000002 billed');
    assert.equal(dayLine({ answers: 0, usd: '0.000000' }), '  last 24 h             no answers');
  });
});

describe('the node console says how many answers went out paced', () => {
  it('puts the count under the day\'s earnings, in the words the page uses', () => {
    assert.equal(pacedSentence(23, 40), '23 of the 40 answers went out on the hidden beat, one 4 KiB frame a beat, as the routers that sent them asked.');
    assert.equal(pacedSentence(1, 1), '1 of the 1 answer went out on the hidden beat, one 4 KiB frame a beat, as the routers that sent them asked.');
    const page = providerConsolePage();
    assert.ok(page.includes('<p class="lede" id="paced" hidden></p>'));
    assert.ok(page.includes('const pacedSentence='));
  });
});
