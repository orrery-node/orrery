import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ed25519Verify, signerOf } from '../src/keys.ts';
import { decrypt, encrypt, newEnclaveKey, openRequest, padFrame, padRequest, sealRequest, wireMessage } from '../src/seal.ts';
import { test } from 'node:test';

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

test('a request is padded to its size class with spaces JSON ignores', () => {
  const sizes = [[10, 1024], [1024, 1024], [1025, 2048], [5000, 8192], [40_000, 65_536], [65_536, 65_536], [70_000, 131_072], [200_000, 262_144]];
  for (const [n, want] of sizes) assert.equal(padRequest(Buffer.alloc(n, 0x41)).length, want, `${n} bytes`);
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  const padded = padRequest(Buffer.from(body));
  assert.deepEqual(JSON.parse(padded.toString('utf8')), JSON.parse(body), 'a node that parses JSON sees the same request');
  assert.equal(padded.subarray(body.length).toString().trim(), '', 'only spaces were added');
});

test('an answer frame is padded to a whole number of 256-byte blocks, and still parses', () => {
  for (const [n, want] of [[1, 256], [180, 256], [256, 256], [257, 512], [900, 1024]]) assert.equal(padFrame('x'.repeat(n)).length, want, `${n} bytes`);
  const one = JSON.stringify({ choices: [{ index: 0, delta: { content: ' a' } }] });
  const two = JSON.stringify({ choices: [{ index: 0, delta: { content: ' extraordinarily' } }] });
  assert.equal(padFrame(one).length, padFrame(two).length, 'a short token and a long one look the same');
  assert.deepEqual(JSON.parse(padFrame(two).toString('utf8')), JSON.parse(two));
});
