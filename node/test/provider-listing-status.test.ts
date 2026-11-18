import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as check from '../src/provider/check.ts';

type Acct = { active: boolean; manifestHash: Buffer; endpoint: string };
const c = check as unknown as { listingState?: (a: Acct | null, n: { manifestHash: Buffer; publicUrl: string }) => string; listingLine?: (s: string, o: { config: string; endpoint?: string }) => string };
const mine = { manifestHash: Buffer.from('aa', 'hex'), publicUrl: 'https://gpu.example.org' };
const onChain = (over: Partial<Acct> = {}): Acct => ({ active: true, manifestHash: Buffer.from('aa', 'hex'), endpoint: 'https://gpu.example.org', ...over });

describe('provider status: where the listing stands', () => {
  it('tells the five states apart, a closed listing before a changed one', () => {
    assert.equal(typeof c.listingState, 'function', 'check.ts names the state');
    assert.equal(c.listingState!(onChain(), mine), 'listed');
    assert.equal(c.listingState!(null, mine), 'missing');
    assert.equal(c.listingState!(onChain({ active: false, manifestHash: Buffer.from('bb', 'hex') }), mine), 'closed');
    assert.equal(c.listingState!(onChain({ manifestHash: Buffer.from('bb', 'hex'), endpoint: 'https://old.example.org' }), mine), 'prices_changed');
    assert.equal(c.listingState!(onChain({ endpoint: 'https://old.example.org' }), mine), 'address_changed');
  });

  it('says what each state means for routers and the one command that clears it', () => {
    const o = { config: 'provider.json', endpoint: 'https://old.example.org' };
    assert.equal(c.listingLine!('listed', o), '  listing               on chain, with this node’s prices and address');
    assert.equal(c.listingLine!('missing', o), '  listing               not on chain yet, so no router can find this node: orrery provider register --config provider.json');
    assert.equal(c.listingLine!('closed', o), '  listing               closed on chain, so no router uses this node');
    assert.equal(c.listingLine!('prices_changed', o), '  listing               provider.json has prices the chain does not, so a router reading them now refuses this node: orrery provider register --config provider.json');
    assert.equal(c.listingLine!('address_changed', o), '  listing               on chain under https://old.example.org, so routers go there: orrery provider register --config provider.json');
  });
});
