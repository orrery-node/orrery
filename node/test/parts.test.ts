import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { checkTiers, discounted, knownOff, sharePct, tierOff } from '../src/holder.ts';
import { isTransient } from '../src/chain/send.ts';
import { canonical, checkManifest, manifestHash, type Manifest } from '../src/manifest.ts';
import { costOf, usd } from '../src/pricing.ts';
import { decrypt, encrypt, newEnclaveKey, openRequest, sealRequest } from '../src/seal.ts';
import { nextUsageHash, ZERO_HASH } from '../src/usage.ts';
import { parseModel, rank, reputation, Stats } from '../src/router/policy.ts';
import type { ProviderEntry } from '../src/router/registry.ts';

const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  v: 1, name: 'n', authority: 'a', nodeKey: 'k', models: [{ id: 'llama-3.3-70b', context: 131072, maxOutput: 8192, price: { input: 120_000, output: 300_000 } }], ...over,
});

describe('pricing', () => {
  it('rounds every request up to the next base unit and never down to free', () => {
    assert.equal(costOf({ input: 600_000, output: 2_400_000 }, 500, 200), 780n);
    assert.equal(costOf({ input: 1, output: 1 }, 1, 0), 1n);
    assert.equal(costOf({ input: 0, output: 0 }, 1000, 1000), 0n);
    assert.equal(usd(1_234_567n), '1.234567');
    assert.equal(usd(780n, 4), '0.0007');
  });
});

describe('manifest', () => {
  it('hashes the same no matter the key order', () => {
    const a = manifest();
    const b = JSON.parse(JSON.stringify({ models: a.models, nodeKey: 'k', authority: 'a', name: 'n', v: 1 }));
    assert.deepEqual(canonical(a), canonical(b));
    assert.deepEqual(manifestHash(a), manifestHash(canonical(b)));
  });
  it('rejects bad ids and prices', () => {
    assert.throws(() => checkManifest(manifest({ models: [{ id: 'Bad Id', context: 1, maxOutput: 1, price: { input: 1, output: 1 } }] })));
    assert.throws(() => checkManifest(manifest({ models: [{ id: 'ok', context: 1, maxOutput: 1, price: { input: -1, output: 1 } }] })));
    assert.ok(checkManifest(manifest()));
  });
});

describe('holder pricing', () => {
  const tiers = checkTiers([{ share: 10, off: 2_000 }, { share: 100, off: 3_500 }]);
  const supply = 1_000_000_000_000_000n;
  it('gives the best tier the wallet holds, by share of supply', () => {
    assert.equal(tierOff(tiers, 0n, supply), 0);
    assert.equal(tierOff(tiers, supply / 1_000n - 1n, supply), 0);
    assert.equal(tierOff(tiers, supply / 1_000n, supply), 2_000);
    assert.equal(tierOff(tiers, supply / 100n - 1n, supply), 2_000);
    assert.equal(tierOff(tiers, supply / 50n, supply), 3_500);
    assert.equal(tierOff(undefined, supply, supply), 0);
    assert.equal(tierOff(tiers, supply, 0n), 0);
    assert.equal(sharePct({ mint: 'm', balance: supply / 50n, supply }), '2.00%');
    assert.equal(sharePct({ mint: 'm', balance: supply / 1_000n, supply }), '0.1000%');
  });
  it('discounts both prices the same integer way on both sides', () => {
    assert.deepEqual(discounted({ input: 708_000, output: 948_000 }, 3_500), { input: 460_200, output: 616_200 });
    assert.deepEqual(discounted({ input: 7, output: 3 }, 2_000), { input: 5, output: 2 });
    assert.deepEqual(discounted({ input: 7, output: 3 }, 0), { input: 7, output: 3 });
    assert.ok(costOf(discounted({ input: 120_000, output: 300_000 }, 3_500), 21, 23) < costOf({ input: 120_000, output: 300_000 }, 21, 23));
  });
  it('only accepts tiers that rise together, and only discounts a manifest lists', () => {
    assert.throws(() => checkTiers([]));
    assert.throws(() => checkTiers([{ share: 100, off: 2_000 }, { share: 10, off: 3_500 }]));
    assert.throws(() => checkTiers([{ share: 10, off: 3_500 }, { share: 100, off: 2_000 }]));
    assert.throws(() => checkTiers([{ share: 10, off: 9_500 }]));
    assert.equal(knownOff(tiers, 3_500), 3_500);
    assert.equal(knownOff(tiers, 5_000), 0);
    assert.equal(knownOff(undefined, 2_000), 0);
  });
  it('puts the tiers inside the manifest hash', () => {
    const base: Manifest = { v: 1, name: 'n', authority: 'a', nodeKey: 'k', models: [{ id: 'm', context: 1, maxOutput: 1, price: { input: 1, output: 1 } }] };
    const withTiers: Manifest = { ...base, holder: { tiers } };
    assert.notDeepEqual(manifestHash(base), manifestHash(withTiers));
    assert.doesNotThrow(() => checkManifest(withTiers));
    assert.throws(() => checkManifest({ ...base, holder: { tiers: [{ share: 0, off: 1 }] } }));
  });
});

describe('sending', () => {
  it('retries only the RPC hiccups, not the transaction failing', () => {
    assert.ok(isTransient(new Error('Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[]. \nCatch the `SendTransactionError`')));
    assert.ok(isTransient(new Error('Transaction simulation failed: Blockhash not found')));
    assert.ok(!isTransient(new Error('Simulation failed. Logs: ["Program log: AnchorError ... NothingToRedeem"]')));
    assert.ok(!isTransient(new Error('custom program error: 0xbc4')));
  });
});

describe('sealed requests', () => {
  it('only the enclave key opens a request, and the reply key matches on both sides', () => {
    const enclave = newEnclaveKey();
    const { body, key } = sealRequest(enclave.publicKey, Buffer.from('{"model":"x","messages":[]}'));
    const wire = JSON.parse(body);
    assert.ok(!body.includes('messages'));
    const opened = openRequest(enclave, wire);
    assert.equal(opened.plaintext.toString(), '{"model":"x","messages":[]}');
    assert.deepEqual(opened.key, key);
    assert.equal(decrypt(key, encrypt(opened.key, Buffer.from('reply'))).toString(), 'reply');
    assert.throws(() => openRequest(newEnclaveKey(), wire));
  });
});

describe('usage chain', () => {
  it('changes with every field of every record', () => {
    const r = { requestId: 'r1', model: 'm', inputTokens: 10, outputTokens: 5, cost: 7n };
    const h = nextUsageHash(ZERO_HASH, r);
    assert.notDeepEqual(h, nextUsageHash(ZERO_HASH, { ...r, cost: 8n }));
    assert.notDeepEqual(nextUsageHash(h, r), h);
  });
});

const entry = (name: string, o: { settled?: bigint; redeems?: bigint; days?: number; bonded?: bigint; tee?: boolean; input?: number; output?: number }): { entry: ProviderEntry; offer: Manifest['models'][number] } => {
  const offer = { id: 'm', context: 8192, maxOutput: 4096, price: { input: o.input ?? 100_000, output: o.output ?? 200_000 } };
  return {
    offer,
    entry: {
      address: name, problem: null, checkedAt: 0,
      manifest: manifest({ name, models: [offer] }),
      tee: o.tee ? { verified: true, dev: false, reason: 'ok', enclaveKey: Buffer.alloc(32) } : null,
      account: {
        authority: PublicKey.default, nodeKey: PublicKey.default, endpoint: 'http://x', manifestHash: Buffer.alloc(32), manifestSeq: 1, active: true,
        teeKind: o.tee ? 1 : 0, teeMeasurement: Buffer.alloc(48), teeReportHash: Buffer.alloc(32), teeKey: Buffer.alloc(32), teeExpiresAt: 0n,
        bonded: o.bonded ?? 0n, unbonding: 0n, unbondAt: 0n, settled: o.settled ?? 0n, redeems: o.redeems ?? 0n, channels: 0n,
        registeredAt: BigInt(Math.floor(Date.now() / 1000 - (o.days ?? 0) * 86_400)), lastSettledAt: 0n,
      },
    },
  };
};

describe('routing', () => {
  it('reads route suffixes and leaves other colons alone', () => {
    assert.deepEqual(parseModel('qwen3-32b:private', 'auto'), { model: 'qwen3-32b', route: 'privacy' });
    assert.deepEqual(parseModel('llama:cheap', 'auto'), { model: 'llama', route: 'price' });
    assert.deepEqual(parseModel('org/model:v2', 'speed'), { model: 'org/model:v2', route: 'speed' });
  });

  it('price picks the cheapest, privacy only verified enclaves, reputation the proven one', () => {
    const offers = [
      entry('cheap', { input: 50_000, output: 100_000 }),
      entry('proven', { settled: 900_000_000n, redeems: 800n, days: 120, input: 200_000, output: 400_000 }),
      entry('sealed', { tee: true, input: 150_000, output: 300_000 }),
    ];
    const s = new Stats();
    assert.equal(rank(offers, 'price', 1000, 500, s)[0].entry.address, 'cheap');
    assert.deepEqual(rank(offers, 'privacy', 1000, 500, s).map((c) => c.entry.address), ['sealed']);
    assert.equal(rank(offers, 'reputation', 1000, 500, s)[0].entry.address, 'proven');
  });

  it('a failing provider cools down and drops out of the list', () => {
    const offers = [entry('a', {}), entry('b', { input: 200_000 })];
    const s = new Stats();
    s.fail('a');
    assert.deepEqual(rank(offers, 'price', 100, 100, s).map((c) => c.entry.address), ['b']);
  });

  it('settled money moves reputation more than age alone', () => {
    const s = new Stats();
    const old = reputation(entry('old', { days: 200 }).entry, s.get('x'), 0n);
    const paid = reputation(entry('paid', { settled: 500_000_000n, redeems: 300n }).entry, s.get('x'), 0n);
    assert.ok(paid > old);
  });
});

describe('provider upstream', () => {
  it('forwards standard chat fields only, so a caller cannot spend the operator key on other models or tools', async () => {
    const { upstreamBody } = await import('../src/provider/node.ts');
    const out = upstreamBody(
      { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, tools: [{ type: 'function' }], models: ['expensive/model'], plugins: [{ id: 'web' }], provider: { order: ['x'] }, n: 4, reasoning: { max_tokens: 9999 } },
      'meta-llama/llama-3.3-70b-instruct',
      512,
    );
    assert.deepEqual(Object.keys(out).sort(), ['max_tokens', 'messages', 'model', 'stream', 'stream_options', 'temperature', 'tools']);
    assert.equal(out.model, 'meta-llama/llama-3.3-70b-instruct');
    assert.equal(out.max_tokens, 512);
  });
});
