import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newer, render, versionCheck } from '../src/doctor.ts';
import { paidLine } from '../src/doctor.ts';

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
});
