import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTrip, readTrips, summarize, windowMs } from '../src/spend.ts';

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
});
