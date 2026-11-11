import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ed25519Verify, signerOf } from '../src/keys.ts';
import { decrypt, encrypt, newEnclaveKey, openRequest, sealRequest, wireMessage } from '../src/seal.ts';

describe('wire sealing', () => {
  it('a request sealed to the node’s own key opens only with that key, and the reply comes back under the same secret', () => {
    const node = newEnclaveKey();
    const prompt = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: "'; DROP TABLE users; -- ../../etc/shadow" }] }));
    const sealed = sealRequest(node.publicKey, prompt, 'wire');
    const body = JSON.parse(sealed.body) as { wire?: number; sealed?: number; epk: string; box: string };
    assert.equal(body.wire, 1);
    assert.equal(body.sealed, undefined);
    assert.equal(sealed.body.includes('DROP TABLE'), false);
    const opened = openRequest(node, body);
    assert.deepEqual(opened.plaintext, prompt);
    assert.equal(decrypt(sealed.key, encrypt(opened.key, Buffer.from('answer'))).toString(), 'answer');
    assert.throws(() => openRequest(newEnclaveKey(), body));
  });
  it('the key is accepted only with the signature of the node key on the listing', () => {
    const nodeKey = Keypair.generate(), other = Keypair.generate();
    const wire = newEnclaveKey();
    const sig = signerOf(nodeKey)(wireMessage(wire.publicKey));
    assert.equal(ed25519Verify(nodeKey.publicKey.toBytes(), wireMessage(wire.publicKey), sig), true);
    assert.equal(ed25519Verify(other.publicKey.toBytes(), wireMessage(wire.publicKey), sig), false);
    assert.equal(ed25519Verify(nodeKey.publicKey.toBytes(), wireMessage(newEnclaveKey().publicKey), sig), false);
  });
  it('an enclave request keeps its own tag', () => {
    assert.equal(JSON.parse(sealRequest(newEnclaveKey().publicKey, Buffer.from('{}')).body).sealed, 1);
  });
});
