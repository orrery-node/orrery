import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consolePage, spendNotes } from '../src/router/console.ts';

describe('the router console under its spend', () => {
  it('says what was signed nothing: answers a node did not give or finish, and requests no node answered', () => {
    assert.equal(spendNotes({ afterANodeDidNotAnswer: { answers: 2, nodes: 3 }, finishedByAnotherNode: 1, unanswered: { requests: 2, nodes: 3 } }),
      '2 of these answers came from the next node after another did not answer (3 skipped in all); 1 was finished by another node after the first stopped mid-answer. A node that does not answer or does not finish is signed nothing. 2 requests got no answer from any node asked (3 nodes asked in all); nothing was signed or paid for them.');
    assert.equal(spendNotes({ afterANodeDidNotAnswer: { answers: 0, nodes: 0 }, finishedByAnotherNode: 0, unanswered: { requests: 0, nodes: 0 } }), '');
    assert.equal(spendNotes({}), '');
  });

  it('the page carries the note and the code that writes it', () => {
    const page = consolePage();
    assert.ok(page.includes('id="spendnote"'));
    assert.ok(page.includes('const spendNotes='));
  });
});
