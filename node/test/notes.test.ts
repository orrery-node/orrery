import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEET_MAX, notesFrom, parseNotes, peerText, readIntroductions, readPeerNotes, signNotes, sumPeers, type Note } from '../src/router/notes.ts';
import { Keypair } from '@solana/web3.js';
import { signerOf } from '../src/keys.ts';

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

describe('signed notes', () => {
  const router = Keypair.generate();
  const by = router.publicKey.toBase58();
  const notes = signNotes({ notes: 1, at: Date.now(), nodes: [{ address: A, checks: 60, up: 58, sent: 41, answered: 40 }] }, by, signerOf(router));

  it('a router signs its notes with its session key, and a reader checks who said them', () => {
    assert.deepEqual(readPeerNotes(notes), { by, signed: true, nodes: notes.nodes });
    assert.deepEqual(readPeerNotes(notes, by), { by, signed: true, nodes: notes.nodes });
  });

  it('notes changed on the way are refused, whoever passes them on', () => {
    const changed = { ...notes, nodes: [{ ...notes.nodes[0], up: 59 }] };
    assert.deepEqual(readPeerNotes(changed), { refused: 'the signature does not match the notes' });
  });

  it('a peer pinned to a key must sign with that key', () => {
    const other = Keypair.generate().publicKey.toBase58();
    assert.deepEqual(readPeerNotes(notes, other), { refused: `signed by ${by}, not the router pinned for this peer` });
    const unsigned = { notes: 1, at: Date.now(), nodes: notes.nodes };
    assert.deepEqual(readPeerNotes(unsigned, by), { refused: 'not signed, and this peer is pinned to a key' });
    assert.deepEqual(readPeerNotes(unsigned), { by: null, signed: false, nodes: notes.nodes });
  });

  it('signed notes from over an hour ago, or dated ahead, are refused: anyone can pass old signed notes on again', () => {
    const now = 10_000_000_000;
    const old = signNotes({ notes: 1, at: now - 2 * 3_600_000, nodes: notes.nodes }, by, signerOf(router));
    assert.deepEqual(readPeerNotes(old, undefined, now), { refused: 'the notes are 120 min old; older than an hour is not used' });
    const ahead = signNotes({ notes: 1, at: now + 5 * 60_000, nodes: notes.nodes }, by, signerOf(router));
    assert.deepEqual(readPeerNotes(ahead, undefined, now), { refused: 'the notes are dated in the future' });
    const fresh = signNotes({ notes: 1, at: now - 60_000, nodes: notes.nodes }, by, signerOf(router));
    assert.equal((readPeerNotes(fresh, by, now) as { signed: boolean }).signed, true);
  });

  it('reads a peer\'s introductions as url#key, keeping only http(s) addresses with a well-formed key', () => {
    const k = Keypair.generate().publicKey.toBase58();
    assert.equal(MEET_MAX, 8);
    assert.deepEqual(readIntroductions({ peers: [
      { url: 'http://10.0.0.7:7171/', by: k },
      { url: 'http://10.0.0.7:7171', by: k },
      { url: 'ftp://10.0.0.8', by: k },
      { url: 'http://10.0.0.9:7171#other', by: k },
      { url: 'http://10.0.0.10:7171', by: 'not a key' },
      { url: 'https://router.example', by: k },
      null,
    ] }), [`http://10.0.0.7:7171#${k}`, `https://router.example#${k}`]);
    assert.deepEqual(readIntroductions({ nope: 1 }), []);
    assert.equal(readIntroductions({ peers: Array.from({ length: 40 }, (_, i) => ({ url: `http://10.0.1.${i}:7171`, by: k })) }).length, 32);
  });
});
