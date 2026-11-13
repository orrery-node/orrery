import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { signerOf } from '../src/keys.ts';
import { insideMessage, newEnclaveKey, wireMessage } from '../src/seal.ts';
import { readWire } from '../src/router/registry.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('the flag a node sets to say it reads payment inside the seal', () => {
  const node = Keypair.generate();
  const wire = newEnclaveKey();
  const signed = { key: hex(wire.publicKey), sig: hex(signerOf(node)(wireMessage(wire.publicKey))) };
  it('counts when the node key signed it for this wire key', () => {
    const w = readWire({ ...signed, inside: true, insideSig: hex(signerOf(node)(insideMessage(wire.publicKey))) }, node.publicKey);
    assert.equal(w?.inside, true);
  });
  it('does not count without a signature, or with one from another key or for another wire key', () => {
    assert.equal(readWire({ ...signed, inside: true }, node.publicKey)?.inside, false);
    assert.equal(readWire({ ...signed, inside: true, insideSig: hex(signerOf(Keypair.generate())(insideMessage(wire.publicKey))) }, node.publicKey)?.inside, false);
    assert.equal(readWire({ ...signed, inside: true, insideSig: hex(signerOf(node)(insideMessage(newEnclaveKey().publicKey))) }, node.publicKey)?.inside, false);
  });
  it('a signature over the wire key itself is not taken as one over the flag', () => {
    assert.equal(readWire({ ...signed, inside: true, insideSig: signed.sig }, node.publicKey)?.inside, false);
  });
  it('a wire key without the node key’s signature is not read at all', () => {
    assert.equal(readWire({ key: signed.key, sig: hex(signerOf(Keypair.generate())(wireMessage(wire.publicKey))), inside: true }, node.publicKey), null);
  });
});
