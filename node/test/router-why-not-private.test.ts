import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { whyNotPrivate } from '../src/router/server.ts';

const node = (name: string, tee: { verified: boolean; reason: string } | null = null) => ({ entry: { manifest: { name }, address: `${name}-address`, tee } });

describe(':private with nowhere to go', () => {
  it('names the enclave claims this router could not verify, with their reasons', () => {
    assert.equal(whyNotPrivate([node('A', { verified: false, reason: 'debug mode allowed' }), node('B')]), ' (A: debug mode allowed)');
  });

  it('says what it means when no node serving the model claims an enclave, and how one would', () => {
    assert.equal(whyNotPrivate([node('A'), node('B')]), `: none of the 2 nodes serving it runs in an enclave yet. Without :private, a request to them is still sealed to the node's own key, which keeps it from the node's host but not from its operator. A node offers :private by running on AMD SEV-SNP or Intel TDX ("tee" in provider.json)`);
    assert.match(whyNotPrivate([node('A')]), /^: the one node serving it doesn't run in an enclave yet\. Without :private, a request to it is still sealed/);
    assert.equal(whyNotPrivate([]), '');
    assert.equal(whyNotPrivate([node('A', { verified: true, reason: 'ok' })]), '');
  });
});
