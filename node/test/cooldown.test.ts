import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, Stats } from '../src/router/policy.ts';
import { away, nextWait, patienceFrom } from '../src/router/patience.ts';
import { ChannelUnknown } from '../src/router/channels.ts';
import type { ProviderEntry } from '../src/router/registry.ts';
import type { ModelOffer } from '../src/manifest.ts';

const offerAt = (address: string, input = 100_000) => ({
  entry: { address, account: { bonded: 0n, settled: 0n, redeems: 0n, registeredAt: BigInt(Math.floor(Date.now() / 1000)) }, manifest: null, problem: null, checkedAt: 0, tee: null } as unknown as ProviderEntry,
  offer: { id: 'm', context: 8_000, maxOutput: 1_000, price: { input, output: input * 2 } } as unknown as ModelOffer,
});
const names = (cs: { entry: ProviderEntry }[]) => cs.map((c) => c.entry.address);

test('a cooldown sends requests to another node; when there is no other, the only node is tried again', () => {
  const stats = new Stats();
  const a = offerAt('A'), b = offerAt('B', 200_000);
  stats.fail('A');
  assert.ok(stats.get('A').cooldownUntil > Date.now(), 'the node that failed is cooling down');
  for (const route of ['auto', 'price', 'speed', 'reputation'] as const) {
    assert.deepEqual(names(rank([a, b], route, 100, 100, stats)), ['B'], `${route}: the other node answers while A cools down`);
    assert.deepEqual(names(rank([a], route, 100, 100, stats)), ['A'], `${route}: A is the only node of this model, so it is asked again`);
  }
  stats.fail('B');
  assert.deepEqual(names(rank([a, b], 'price', 100, 100, stats)), ['A', 'B'], 'both cooling down: both are asked, cheapest first');
});

test('what counts as a node being away for a moment, and what is a refusal', () => {
  for (const e of [new TypeError('fetch failed'), new Error('provider answered 502'), new Error('provider answered 503'), new Error('provider answered 504'), new Error('connect ECONNREFUSED 127.0.0.1:1'),
    new Error('read ECONNRESET'), new Error('the proxy at 127.0.0.1:8118 refused a tunnel to node.example:443 (502)'), new ChannelUnknown('an open channel to this node is on chain, but the node did not say where it stands')]) assert.equal(away(e), true, e.message);
  for (const e of [new Error('provider answered 500'), new Error('provider answered 400'), new Error('payment refused: channel_closing'), new Error('enclave not verified'),
    new Error('provider closed the stream without a usage record')]) assert.equal(away(e), false, e.message);
});

test('a request may say how long it waits for an absent node, in seconds, up to 30', () => {
  assert.equal(patienceFrom(undefined, 8_000), 8_000, 'nothing said: the router\'s own setting');
  assert.equal(patienceFrom('0', 8_000), 0);
  assert.equal(patienceFrom('2.5', 8_000), 2_500);
  assert.equal(patienceFrom(' 20 ', 8_000), 20_000);
  for (const bad of ['', 'forever', '-1', '31', 'NaN', '1e9', '5s']) assert.throws(() => patienceFrom(bad, 8_000), /x-orrery-patience is a number of seconds from 0 to 30/, bad);
});

test('more patience means more rounds, each at most 3 seconds apart, never past the limit', () => {
  assert.equal(nextWait(0, 0, 8_000), 1_500);
  assert.equal(nextWait(1, 1_600, 8_000), 3_000);
  assert.equal(nextWait(2, 4_700, 8_000), 3_000, 'a third round still fits in 8 seconds');
  assert.equal(nextWait(3, 7_800, 8_000), null);
  assert.equal(nextWait(6, 20_000, 30_000), 3_000, 'an agent that asked for 30 seconds keeps asking');
  assert.equal(nextWait(0, 0, 0), null, 'patience 0: no round at all');
});
