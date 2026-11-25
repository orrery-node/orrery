import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keptPeerNotes, MEET_MAX, MET_WEIGHT, notesFrom, parseNotes, parsePeersFile, peerBackoffMs, peerFreshness, peersFileNames, peerPrior, peerText, readIntroductions, readPeerNotes, readRelayFull, readRelayOpen, readRelayPort, signNotes, sumPeers, type Note } from '../src/router/notes.ts';
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

  it('waits longer before reading a peer that keeps missing: nothing for three misses, then a minute, doubling up to ten', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 12].map(peerBackoffMs), [0, 0, 0, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it('starts a never-asked node from what the peers saw, a given peer in full and a met router at half the distance', () => {
    const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;
    assert.equal(MET_WEIGHT, 0.5);
    assert.equal(peerPrior([]), null);
    assert.equal(peerPrior([{ weight: 1, sent: 0, answered: 0 }]), null);
    assert.ok(near(peerPrior([{ weight: 1, sent: 40, answered: 0 }]), 0));
    assert.ok(near(peerPrior([{ weight: 0.5, sent: 40, answered: 0 }]), 0.3));
    assert.ok(near(peerPrior([{ weight: 0.5, sent: 40, answered: 40 }]), 0.8));
    assert.ok(near(peerPrior([{ weight: 1, sent: 40, answered: 0 }, { weight: 0.5, sent: 40, answered: 40 }]), 1 / 3));
  });

  it('reads the relay port a peer says it runs, and nothing from a port that is not one', () => {
    assert.equal(readRelayPort({ peers: [], relay: { port: 7272 } }), 7272);
    assert.equal(readRelayPort({ peers: [], relay: null }), null);
    assert.equal(readRelayPort({ peers: [] }), null);
    assert.equal(readRelayPort({ relay: { port: 70000 } }), null);
    assert.equal(readRelayPort({ relay: { port: '7272' } }), null);
    assert.equal(readRelayPort(null), null);
  });

  it('reads a peers file: one address a line, notes and blank lines left out, a pinned key kept, anything else dropped', () => {
    const k = Keypair.generate().publicKey.toBase58();
    assert.deepEqual(parsePeersFile(`# friends\nhttp://10.0.0.2:7171\n\n  https://router.example#${k}  \nnot a url\nftp://x\nhttp://10.0.0.2:7171\r\n`), ['http://10.0.0.2:7171', `https://router.example#${k}`]);
    assert.equal(parsePeersFile(Array.from({ length: 70 }, (_, i) => `http://10.0.1.${i}:7171`).join('\n')).length, 64);
  });

  it('reads how many connections a peer\'s relay has open, only alongside a relay port', () => {
    assert.equal(readRelayOpen({ relay: { port: 7272, open: 3 } }), 3);
    assert.equal(readRelayOpen({ relay: { port: 7272 } }), null);
    assert.equal(readRelayOpen({ relay: { port: 7272, open: -1 } }), null);
    assert.equal(readRelayOpen({ relay: { open: 3 } }), null);
    assert.equal(readRelayOpen(null), null);
  });

  it('reads a name after a peer\'s address in the peers file, printable and at most 40 characters', () => {
    const k = Keypair.generate().publicKey.toBase58();
    assert.deepEqual([...peersFileNames(`http://10.0.0.2:7171#${k}   alice's GPU box\nhttp://10.0.0.3:7171\n# notes\nhttp://10.0.0.4:7171 ${'x'.repeat(60)}`)], [
      [`http://10.0.0.2:7171#${k}`, "alice's GPU box"],
      ['http://10.0.0.3:7171', null],
      ['http://10.0.0.4:7171', 'x'.repeat(40)],
    ]);
    assert.deepEqual(parsePeersFile('http://10.0.0.2:7171 alice'), ['http://10.0.0.2:7171']);
  });

  it('reads back the notes kept from before a restart only for peers still given, signed as pinned and under an hour old', () => {
    const k = Keypair.generate();
    const by = k.publicKey.toBase58();
    const now = 10_000_000_000;
    const nodes = [{ address: A, checks: 4, up: 4, sent: 2, answered: 2 }];
    const fresh = signNotes({ notes: 1, at: now - 600_000, nodes }, by, signerOf(k));
    const old = signNotes({ notes: 1, at: now - 2 * 3_600_000, nodes }, by, signerOf(k));
    const file = JSON.stringify({ [`http://10.0.0.2:7171#${by}`]: fresh, 'http://10.0.0.3:7171': old, [`http://10.0.0.4:7171#${B}`]: fresh, 'http://10.0.0.5:7171': fresh });
    const kept = keptPeerNotes(file, [`http://10.0.0.2:7171#${by}`, 'http://10.0.0.3:7171', `http://10.0.0.4:7171#${B}`], now);
    assert.deepEqual([...kept.keys()], [`http://10.0.0.2:7171#${by}`]);
    const got = kept.get(`http://10.0.0.2:7171#${by}`)!;
    assert.equal(got.at, now - 600_000);
    assert.equal(got.read.by, by);
    assert.equal(got.read.nodes.length, 1);
    assert.equal(keptPeerNotes('not json', ['http://10.0.0.2:7171'], now).size, 0);
    assert.equal(keptPeerNotes('[1]', ['0'], now).size, 0);
  });

  it('counts a peer\'s notes in full for ten minutes, then less each minute, and not at all at an hour', () => {
    assert.equal(peerFreshness(0), 1);
    assert.equal(peerFreshness(600_000), 1);
    assert.equal(peerFreshness(2_100_000), 0.5);
    assert.equal(peerFreshness(3_600_000), 0);
    assert.equal(peerFreshness(9_000_000), 0);
    assert.equal(peerFreshness(-5_000), 1);
    assert.equal(peerPrior([{ weight: peerFreshness(2_100_000), sent: 40, answered: 0 }]), 0.3);
  });

  it('reads whether a peer\'s relay says it is full for today, and nothing for a peer that runs no relay', () => {
    assert.equal(readRelayFull({ peers: [], relay: { port: 7272, open: 0, full: true } }), true);
    assert.equal(readRelayFull({ peers: [], relay: { port: 7272, open: 3 } }), false);
    assert.equal(readRelayFull({ peers: [], relay: { port: 7272, full: 'yes' } }), false);
    assert.equal(readRelayFull({ peers: [], relay: null }), null);
    assert.equal(readRelayFull(null), null);
  });
});
