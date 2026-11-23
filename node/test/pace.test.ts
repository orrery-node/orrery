import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, PACED_BLOCK, paceFrom } from '../src/provider/pace.ts';
import { padFrame } from '../src/seal.ts';
import { paceClause, privacySentence } from '../src/privacy.ts';

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
