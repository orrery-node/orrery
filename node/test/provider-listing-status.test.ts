import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as check from '../src/provider/check.ts';

type Acct = { active: boolean; manifestHash: Buffer; endpoint: string };
type Node = { manifestHash: Buffer; runningHash?: Buffer | null; publicUrl: string };
const c = check as unknown as {
  listingState: (a: Acct | null, n: Node) => string;
  listingLine: (s: string, o: { config: string; endpoint?: string }) => string;
  servedManifestLine?: (served: Buffer | null, chain: Buffer, url: string) => { ok: boolean | null; what: string; detail: string } | null;
};
const A = Buffer.from('aa', 'hex'), B = Buffer.from('bb', 'hex');
const url = 'https://gpu.example.org';
const onChain = (over: Partial<Acct> = {}): Acct => ({ active: true, manifestHash: A, endpoint: url, ...over });

describe('provider status: where the listing stands', () => {
  it('judges by what the running node serves, since that is what routers read', () => {
    assert.equal(c.listingState(onChain(), { manifestHash: A, runningHash: A, publicUrl: url }), 'listed');
    assert.equal(c.listingState(null, { manifestHash: A, runningHash: A, publicUrl: url }), 'missing');
    assert.equal(c.listingState(onChain({ active: false }), { manifestHash: B, runningHash: B, publicUrl: url }), 'closed');
    assert.equal(c.listingState(onChain(), { manifestHash: B, runningHash: A, publicUrl: url }), 'prices_pending', 'edited, not listed: routers still read the listed prices');
    assert.equal(c.listingState(onChain(), { manifestHash: A, runningHash: B, publicUrl: url }), 'restart_needed', 'listed, not restarted: the node still serves the old prices');
    assert.equal(c.listingState(onChain(), { manifestHash: B, runningHash: B, publicUrl: url }), 'prices_changed', 'restarted on prices the chain does not have');
    assert.equal(c.listingState(onChain({ endpoint: 'https://old.example.org' }), { manifestHash: A, runningHash: A, publicUrl: url }), 'address_changed');
  });

  it('falls back to provider.json when the running node does not say what it serves', () => {
    assert.equal(c.listingState(onChain(), { manifestHash: A, publicUrl: url }), 'listed');
    assert.equal(c.listingState(onChain(), { manifestHash: B, publicUrl: url }), 'prices_changed');
  });

  it('says what each state means for routers and the one command that clears it', () => {
    const o = { config: 'provider.json', endpoint: 'https://old.example.org' };
    assert.equal(c.listingLine('listed', o), '  listing               on chain, with this node’s prices and address');
    assert.equal(c.listingLine('missing', o), '  listing               not on chain yet, so no router can find this node: orrery provider register --config provider.json');
    assert.equal(c.listingLine('closed', o), '  listing               closed on chain, so no router uses this node');
    assert.equal(c.listingLine('prices_pending', o), '  listing               provider.json has new prices that are not live yet, and routers still get the listed ones: orrery provider register --config provider.json, then restart the node');
    assert.equal(c.listingLine('restart_needed', o), '  listing               this node still serves its old prices, so a router reading them now refuses it: restart it with orrery provider start --config provider.json');
    assert.equal(c.listingLine('prices_changed', o), '  listing               this node serves prices the chain does not have, so a router reading them now refuses it: orrery provider register --config provider.json');
    assert.equal(c.listingLine('address_changed', o), '  listing               on chain under https://old.example.org, so routers go there: orrery provider register --config provider.json');
  });
});

describe('provider check: the price list routers read from the public address', () => {
  it('says nothing when it matches the chain, and fails the way a router would when it does not', () => {
    assert.equal(typeof c.servedManifestLine, 'function', 'check.ts writes the line');
    assert.equal(c.servedManifestLine!(A, A, url), null);
    assert.deepEqual(c.servedManifestLine!(B, A, url), { ok: false, what: 'manifest', detail: `the price list ${url} serves is not the one on chain, so routers refuse this node: run provider register if the new prices are right, and restart the node so it serves what is listed` });
    assert.deepEqual(c.servedManifestLine!(null, A, url), { ok: false, what: 'manifest', detail: `${url}/v1/manifest did not answer, so routers cannot read this node’s prices` });
  });
});
