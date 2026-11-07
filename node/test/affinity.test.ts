import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Affinity, prefixes } from '../src/router/affinity.ts';
import { costOf } from '../src/pricing.ts';

const sys = { role: 'system', content: 'You are a careful coding agent. '.repeat(40) };
const turn1 = [sys, { role: 'user', content: 'Fix the failing test.' }];
const turn2 = [...turn1, { role: 'assistant', content: 'Done, the import was wrong.' }, { role: 'user', content: 'Now run it again.' }];

describe('prompt-cache affinity', () => {
  it('gives every prefix of the conversation its own rolling key', () => {
    const a = prefixes('m', turn2), b = prefixes('m', turn1);
    assert.equal(a.length, 4);
    assert.deepEqual(a.slice(0, 2), b);
    assert.notEqual(prefixes('other-model', turn1)[0].key, b[0].key);
    assert.ok(a[3].tokens > a[1].tokens);
  });

  it('finds the provider that served the longest earlier prefix', () => {
    const aff = new Affinity();
    aff.remember(prefixes('m', turn1), 'ironbridge', 1_000);
    const hit = aff.find(prefixes('m', turn2), 2_000);
    assert.equal(hit?.address, 'ironbridge');
    assert.equal(hit?.tokens, prefixes('m', turn1)[1].tokens);
  });

  it('forgets a prefix once the cache has likely expired', () => {
    const aff = new Affinity(5 * 60_000);
    aff.remember(prefixes('m', turn1), 'ironbridge', 0);
    assert.equal(aff.find(prefixes('m', turn2), 5 * 60_000 + 1), null);
  });

  it('a new session with the same system prompt still finds the provider holding it', () => {
    const aff = new Affinity();
    aff.remember(prefixes('m', turn2), 'vault', 0);
    const other = [sys, { role: 'user', content: 'Different task.' }];
    const hit = aff.find(prefixes('m', other), 1);
    assert.equal(hit?.address, 'vault');
    assert.equal(hit?.tokens, prefixes('m', other)[0].tokens);
  });

  it('turns a cheaper list price into the worse deal when the other provider holds the cache', () => {
    const cachedProvider = { input: 37_500, output: 140_000, cachedInput: 9_375 }, cheaperList = { input: 35_000, output: 140_000 };
    const estIn = 1_000, cachedTokens = 950;
    assert.ok(costOf(cheaperList, estIn, 32) < costOf(cachedProvider, estIn, 32));
    assert.ok(costOf(cachedProvider, estIn, 32, cachedTokens) < costOf(cheaperList, estIn, 32, cachedTokens));
  });

  it('keeps at most the configured number of prefixes', () => {
    const aff = new Affinity(60_000, 3);
    for (let i = 0; i < 5; i++) aff.remember(prefixes('m', [{ role: 'user', content: `q${i}` }]), `p${i}`, i);
    assert.equal(aff.find(prefixes('m', [{ role: 'user', content: 'q0' }]), 10), null);
    assert.equal(aff.find(prefixes('m', [{ role: 'user', content: 'q4' }]), 10)?.address, 'p4');
  });
});
