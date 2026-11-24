import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { notesFrom, parseNotes, peerText, sumPeers, type Note } from '../src/router/notes.ts';

const A = '76UdbaSy69DdFv2ciRNQCbyz7ARVZvH4aVJwqBnszDE8';
const B = '7UHevY47LgbJv9hz4iymecR8FURy27jX55KYb1sxytZS';

describe('routers sharing notes on nodes', () => {
  it('a router\'s notes hold what it saw of each node and nothing about its wallet or spending', () => {
    const n = notesFrom([{ address: A, watched: { checks: 60, up: 58, since: 1, sent: 41, answered: 40, askedSince: 1 } }, { address: B, watched: null }], 5);
    assert.deepEqual(n, { notes: 1, at: 5, nodes: [{ address: A, checks: 60, up: 58, sent: 41, answered: 40 }] });
  });

  it('a peer\'s notes are read as data: malformed or impossible notes are dropped', () => {
    assert.equal(parseNotes({ nodes: [] }), null);
    const kept = parseNotes({ notes: 1, at: 1, nodes: [
      { address: A, checks: 10, up: 9, sent: 5, answered: 5 },
      { address: B, checks: 10, up: 11, sent: 5, answered: 5 },
      { address: 'not-an-address', checks: 1, up: 1, sent: 1, answered: 1 },
      { address: B, checks: 3, up: 3, sent: 2, answered: 3 },
      { address: B, checks: -1, up: 0, sent: 0, answered: 0 },
    ] });
    assert.deepEqual(kept, [{ address: A, checks: 10, up: 9, sent: 5, answered: 5 }]);
  });

  it('adds up what the peers saw of one node, and says it apart from this router\'s own record', () => {
    const peers = new Map<string, Note[]>([
      ['http://peer-one', [{ address: A, checks: 60, up: 58, sent: 41, answered: 40 }]],
      ['http://peer-two', [{ address: A, checks: 60, up: 60, sent: 41, answered: 41 }, { address: B, checks: 0, up: 0, sent: 3, answered: 1 }]],
    ]);
    assert.deepEqual(sumPeers(peers, A), { routers: 2, checks: 120, up: 118, sent: 82, answered: 81 });
    assert.equal(peerText(sumPeers(peers, A)), '2 peer routers saw it up in 118 of 120 checks and answering 81 of 82 requests');
    assert.equal(peerText(sumPeers(peers, B)), '1 peer router saw it answering 1 of 3 requests');
    assert.equal(sumPeers(peers, 'nobody'), null);
    assert.equal(peerText(null), '');
  });
});
