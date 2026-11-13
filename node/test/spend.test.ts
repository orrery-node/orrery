import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTrip, paidInside, readTrips, sealedTrips, summarize, windowMs } from '../src/spend.ts';

const t = (at: number, model: string, providerName: string, cost: string, extra = {}) => ({ at, model, provider: providerName.toLowerCase(), providerName, inputTokens: 100, outputTokens: 20, cost, ...extra });

describe('orrery spend', () => {
  it('reads windows in minutes, hours and days', () => {
    assert.equal(windowMs('90m'), 5_400_000);
    assert.equal(windowMs('24h'), 86_400_000);
    assert.equal(windowMs('7d'), 604_800_000);
    assert.equal(windowMs('all'), Infinity);
  });

  it('sums answers, tokens and USDC by model, most expensive first, with an exact total', () => {
    const now = 1_000_000_000;
    const trips = [t(now - 1_000, 'gpt-oss-120b', 'Seed', '0.000014'), t(now - 2_000, 'llama-3.3-70b', 'Seed', '0.000100'), t(now - 3_000, 'gpt-oss-120b', 'Vault', '0.000013', { cacheKept: true }), t(now - 90_000_000, 'gpt-oss-120b', 'Seed', '1.000000')];
    const { rows, total } = summarize(trips, 'model', windowMs('24h'), now);
    assert.deepEqual(rows.map((r) => [r.key, r.answers, r.units]), [['llama-3.3-70b', 1, 100n], ['gpt-oss-120b', 2, 27n]]);
    assert.equal(total.units, 127n);
    assert.equal(total.answers, 3);
    assert.equal(total.inputTokens, 300);
    assert.equal(rows[1].cacheKept, 1);
    assert.deepEqual(summarize(trips, 'provider', Infinity, now).rows.map((r) => r.key), ['Seed', 'Vault']);
  });

  it('appends one line per answer and skips lines it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-spend-'));
    const path = join(dir, 'router', 'trips.jsonl');
    appendTrip(path, t(1, 'm', 'P', '0.000001'));
    appendTrip(path, t(2, 'm', 'P', '0.000002'));
    writeFileSync(path, `${readTrips(path).map((x) => JSON.stringify(x)).join('\n')}\nnot json\n`);
    assert.equal(readTrips(path).length, 2);
    assert.equal(readTrips(join(dir, 'missing.jsonl')).length, 0);
  });

  it('rolls the log over at the size limit and still reads both files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-roll-'));
    const path = join(dir, 'trips.jsonl');
    for (let i = 0; i < 5; i++) appendTrip(path, t(i, 'm', 'P', '0.000001'), 300);
    assert.equal(readTrips(path).length, 5);
    assert.ok(existsSync(`${path}.1`));
  });

  it('keeps, for a sealed answer, the enclave the router verified, and the task an agent named', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-sealed-'));
    const path = join(dir, 'trips.jsonl');
    const enclave = { kind: 'AMD SEV-SNP', image: 'b07af9620f3b839b47996422ddec6058', verdict: 'AMD SEV-SNP report verified (Milan)' };
    appendTrip(path, t(1_000, 'qwen3-32b', 'Vault', '0.000011', { sealed: true, enclave, task: 'audit-7' }));
    appendTrip(path, t(2_000, 'llama-3.3-70b', 'Seed', '0.000020', { task: 'audit-7' }));
    appendTrip(path, t(3_000, 'llama-3.3-70b', 'Seed', '0.000005'));
    const back = readTrips(path);
    assert.deepEqual(back[0].enclave, enclave);
    assert.equal(back[1].sealed, undefined);
    assert.deepEqual(sealedTrips(back, Infinity, 5_000).map((x) => [x.providerName, x.enclave?.kind]), [['Vault', 'AMD SEV-SNP']]);
    const byTask = summarize(back, 'task', Infinity, 5_000);
    assert.deepEqual(byTask.rows.map((r) => [r.key, r.answers, r.units]), [['audit-7', 2, 31n], ['(no task)', 1, 5n]]);
  });
});

it('a node’s log keeps which answers were paid inside the seal, and counts them over a window', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'served-')), 'served.jsonl');
  const now = Date.now();
  const base = { model: 'm', provider: 'c', providerName: 'C', inputTokens: 1, outputTokens: 1, cost: '0.000001' };
  appendTrip(path, { ...base, at: now - 1_000, inside: true });
  appendTrip(path, { ...base, at: now - 2_000 });
  appendTrip(path, { ...base, at: now - 3_000, inside: true });
  appendTrip(path, { ...base, at: now - 48 * 3600_000, inside: true });
  assert.deepEqual(paidInside(readTrips(path), 24 * 3600_000, now), { answers: 3, inside: 2 });
});
