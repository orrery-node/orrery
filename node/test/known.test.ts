import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { KNOWN_MAX, knownList, knowsFileLines, knowsSentence, readKnown } from '../src/known.ts';
import { foundThroughNodes, mapLine } from '../src/doctor.ts';
import { knowsCheckLine } from '../src/provider/check.ts';

const a = Keypair.generate().publicKey.toBase58();
const b = Keypair.generate().publicKey.toBase58();
const own = Keypair.generate().publicKey.toBase58();

describe('nodes naming other nodes', () => {
  it('a node names each listing it was given once, well-formed, never its own', () => {
    assert.deepEqual(knownList([a, ` ${b} `, a, 'not-a-listing', own], own), [a, b]);
    assert.deepEqual(knownList(undefined, own), []);
    assert.equal(knownList(Array.from({ length: KNOWN_MAX + 10 }, () => Keypair.generate().publicKey.toBase58()), own).length, KNOWN_MAX);
  });

  it('a router reads a node\'s list as data: well-formed addresses only, at most KNOWN_MAX', () => {
    assert.deepEqual(readKnown({ known: [a, 7, 'x', a, b] }), [a, b]);
    assert.deepEqual(readKnown({ known: 'nope' }), []);
    assert.deepEqual(readKnown(null), []);
  });

  it('the map line counts the listings the router has only because nodes named them', () => {
    assert.equal(mapLine([{ address: a, found: 'rpc' }, { address: b, found: 'nodes' }]), "the map: 2 listings, 1 in the RPC's list, 1 named by nodes");
  });

  it('orrery peers says which nodes named each listing found that way', () => {
    assert.deepEqual(foundThroughNodes([{ address: a, found: 'rpc' }, { address: b, name: 'Halo Compute', found: 'nodes', namedBy: ['Ironbridge Compute'] }]), [`  Halo Compute (${b.slice(0, 4)}\u2026${b.slice(-4)}): named by Ironbridge Compute at /orrery/known, read on chain`]);
    assert.deepEqual(foundThroughNodes([{ address: a, found: 'rpc' }]), []);
  });

  it('orrery provider check says whether each listing a node names is an open listing on chain', () => {
    assert.equal(knowsCheckLine([], new Set()), null);
    assert.deepEqual(knowsCheckLine([a, b], new Set([a, b])), { ok: true, what: 'knows', detail: 'names 2 nodes at /orrery/known, each an open listing on chain' });
    assert.deepEqual(knowsCheckLine([a, b], new Set([a])), { ok: false, what: 'knows', detail: `names 2 at /orrery/known; 1 is not an open listing on chain, so routers leave it off: ${b}` });
  });

  it('a --knows-file has one listing a line, notes after #, blank lines skipped', () => {
    assert.deepEqual(knowsFileLines(`# my other nodes\n${a}  # the A100 box\n\n  ${b}\n`), [a, b]);
    assert.deepEqual(knowsFileLines(''), []);
  });

  it('provider status and the node console say how many nodes this node names, and from which file', () => {
    assert.equal(knowsSentence({ count: 0, file: null }), '');
    assert.equal(knowsSentence(null), '');
    assert.equal(knowsSentence({ count: 1, file: null }), 'Names 1 other node at /orrery/known: routers that read this node check each on chain and add it to their map.');
    assert.equal(knowsSentence({ count: 3, file: '/srv/knows.txt' }), 'Names 3 other nodes at /orrery/known (--knows and /srv/knows.txt, read again at every request): routers that read this node check each on chain and add it to their map.');
  });
});
