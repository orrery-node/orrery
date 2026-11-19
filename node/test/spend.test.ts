import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as spend from '../src/spend.ts';
import { appendTrip, paidInside, readTrips, sealedTrips, skipNote, skipped, speeds, speedText, summarize, windowMs } from '../src/spend.ts';

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

  it('counts the answers that came from the next node after another did not answer, and says those nodes were signed nothing', () => {
    const now = 1_000_000_000;
    const trips = [t(now - 1_000, 'gpt-oss-120b', 'Seed', '0.000014', { fellThrough: 1 }), t(now - 2_000, 'gpt-oss-120b', 'Seed', '0.000014'), t(now - 3_000, 'gpt-oss-120b', 'Vault', '0.000013', { fellThrough: 2 }), t(now - 90_000_000, 'gpt-oss-120b', 'Seed', '1.000000', { fellThrough: 1 })];
    assert.deepEqual(skipped(trips, windowMs('24h'), now), { answers: 2, nodes: 3, resumed: 0 });
    assert.deepEqual(skipped(trips, Infinity, now), { answers: 3, nodes: 4, resumed: 0 });
    assert.equal(skipNote({ answers: 2, nodes: 3 }), '2 of these answers came from the next node after another did not answer (3 skipped in all). A node that does not answer is signed nothing.');
    assert.equal(skipNote({ answers: 1, nodes: 1 }), '1 of these answers came from the next node after another did not answer. A node that does not answer is signed nothing.');
    assert.equal(skipNote({ answers: 0, nodes: 0 }), '');
    assert.deepEqual(skipped([t(now, 'm', 'Seed', '0.000001')], Infinity, now), { answers: 0, nodes: 0, resumed: 0 });
  });

  it('keeps apart the answers another node finished after the first stopped mid-answer, in the log and in the line', () => {
    const now = 1_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), 'orrery-spend-'));
    const path = join(dir, 'trips.jsonl');
    appendTrip(path, t(now - 1_000, 'gpt-oss-120b', 'Seed', '0.000014', { fellThrough: 1, resumed: true }));
    appendTrip(path, t(now - 2_000, 'gpt-oss-120b', 'Vault', '0.000013', { fellThrough: 2 }));
    appendTrip(path, t(now - 3_000, 'gpt-oss-120b', 'Seed', '0.000014'));
    const back = readTrips(path);
    assert.equal(back[0].resumed, true);
    assert.equal(back[1].resumed, undefined);
    assert.deepEqual(skipped(back, Infinity, now), { answers: 1, nodes: 2, resumed: 1 });
    assert.equal(skipNote({ answers: 1, nodes: 2, resumed: 1 }), '1 of these answers came from the next node after another did not answer (2 skipped in all); 1 was finished by another node after the first stopped mid-answer. A node that does not answer or does not finish is signed nothing.');
    assert.equal(skipNote({ answers: 0, nodes: 0, resumed: 2 }), '2 of these answers were finished by another node after the first stopped mid-answer. A node that does not finish an answer is signed nothing for it.');
    assert.equal(skipNote({ answers: 2, nodes: 2, resumed: 0 }), '2 of these answers came from the next node after another did not answer. A node that does not answer is signed nothing.');
    assert.equal(skipNote({ answers: 0, nodes: 0, resumed: 0 }), '');
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

  it('keeps how long each answer took to start, and gives each node its median for the window', () => {
    const now = 1_800_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), 'orrery-speed-'));
    const log = join(dir, 'trips.jsonl');
    for (const [i, ms] of [900, 300, 500].entries()) appendTrip(log, { ...t(now - i * 1000, 'm', 'Seed', '0.000001'), ttftMs: ms });
    appendTrip(log, { ...t(now - 5000, 'm', 'Other', '0.000001'), ttftMs: 200 });
    appendTrip(log, { ...t(now - 6000, 'm', 'Other', '0.000001'), ttftMs: 400 });
    appendTrip(log, t(now - 7000, 'm', 'Other', '0.000001'));
    appendTrip(log, { ...t(now - 2 * 86_400_000, 'm', 'Seed', '0.000001'), ttftMs: 9000 });
    const read = readTrips(log);
    assert.equal(read[0].ttftMs, 900);
    assert.deepEqual(speeds(read, windowMs('24h'), now), [
      { provider: 'seed', name: 'Seed', answers: 3, medianTtftMs: 500 },
      { provider: 'other', name: 'Other', answers: 2, medianTtftMs: 300 },
    ]);
    assert.equal(speeds(read, Infinity, now)[0].medianTtftMs, 700);
    assert.deepEqual(speeds([t(now, 'm', 'Seed', '0.000001')], Infinity, now), []);
  });

  it('says a node’s speed in one phrase', () => {
    assert.equal(speedText({ answers: 42, medianTtftMs: 934 }), 'started answering in 934 ms (median of 42 answers in the last 24 h)');
    assert.equal(speedText({ answers: 2, medianTtftMs: 310 }), 'started answering in 310 ms (median of 2 answers in the last 24 h)');
    assert.equal(speedText({ answers: 1, medianTtftMs: 2040 }, '7 d'), 'started answering in 2.0 s (1 answer in the last 7 d)');
  });

  it('counts, per node, the answers whose bill was within the prices it listed, from the router’s log', () => {
    const bills = (spend as unknown as { bills?: (t: unknown[], since: number, now: number) => unknown }).bills;
    assert.equal(typeof bills, 'function', 'spend.ts counts bills per node');
    const now = 1_000_000_000_000;
    const t = (provider: string, billed: string | undefined, listed: string | undefined, at = now - 1000) => ({ at, model: 'm', provider, providerName: provider === 'A' ? 'Alpha' : 'Beta', inputTokens: 1, outputTokens: 1, cost: '0.000010', ...(billed ? { billed } : {}), ...(listed ? { listed } : {}) });
    const rows = bills!([t('A', '0.000010', '0.000010'), t('A', '0.000012', '0.000010'), t('B', '0.000005', '0.000006'), t('B', undefined, undefined), t('A', '0.000099', '0.000010', now - 2 * 86_400_000)], 86_400_000, now);
    assert.deepEqual(rows, [{ provider: 'A', name: 'Alpha', checked: 2, over: 1 }, { provider: 'B', name: 'Beta', checked: 1, over: 0 }]);
  });

  it('says what the bills came to in words: all within the listed prices, or how many were above and that no more was paid', () => {
    const billsText = (spend as unknown as { billsText?: (b: { checked: number; over: number }) => string }).billsText;
    assert.equal(typeof billsText, 'function', 'spend.ts says the bills in words');
    assert.equal(billsText!({ checked: 1234, over: 0 }), 'every bill was within its listed prices (1,234 answers in the last 24 h)');
    assert.equal(billsText!({ checked: 1, over: 0 }), 'its bill was within its listed prices (1 answer in the last 24 h)');
    assert.equal(billsText!({ checked: 41, over: 2 }), 'billed above its listed prices in 2 of 41 answers in the last 24 h; this router paid no more than those prices');
  });

  it('writes what the node billed and what its listed prices come to into the log, beside what was paid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-bills-'));
    const path = join(dir, 'trips.jsonl');
    appendTrip(path, { at: 1, model: 'm', provider: 'A', providerName: 'Alpha', inputTokens: 1, outputTokens: 1, cost: '0.000010', billed: '0.000012', listed: '0.000010' } as Parameters<typeof appendTrip>[1]);
    const back = readTrips(path)[0] as { billed?: string; listed?: string; cost: string };
    assert.deepEqual([back.cost, back.billed, back.listed], ['0.000010', '0.000012', '0.000010']);
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

it('orrery spend --by day keeps your books of what the router paid, a UTC day a row, newest first, and --csv gives the rows', () => {
  const s = spend as unknown as { summarize: (t: unknown[], by: string, since: number, now: number) => { rows: { key: string; answers: number; units: bigint }[]; total: { answers: number; units: bigint } }; spendCsv?: (rows: unknown[], by: string) => string };
  assert.equal(typeof s.spendCsv, 'function', 'spend.ts writes the CSV');
  const now = Date.parse('2026-11-19T20:40:00Z');
  const trip = (iso: string, cost: string, task?: string) => ({ at: Date.parse(iso), model: 'llama-3.3-70b', provider: 'p', providerName: 'Orrery Seed', inputTokens: 200, outputTokens: 100, cost, ...(task ? { task } : {}) });
  const trips = [trip('2026-11-18T23:59:59Z', '0.000020'), trip('2026-11-19T00:00:01Z', '0.000030'), trip('2026-11-19T20:00:00Z', '0.000025', 'fix, the "build"'), trip('2026-11-10T12:00:00Z', '0.5')];
  const d = s.summarize(trips, 'day', 7 * 86_400_000, now);
  assert.deepEqual(d.rows.map((r) => [r.key, r.answers, r.units]), [['2026-11-19', 2, 55n], ['2026-11-18', 1, 20n]]);
  assert.equal(d.total.units, 75n);
  assert.equal(s.spendCsv!(d.rows, 'day'), 'day_utc,answers,input_tokens,output_tokens,paid_usdc\n2026-11-19,2,400,200,0.000055\n2026-11-18,1,200,100,0.000020');
  const t = s.summarize(trips, 'task', 7 * 86_400_000, now);
  assert.equal(s.spendCsv!(t.rows, 'task').split('\n')[0], 'task,answers,input_tokens,output_tokens,paid_usdc');
  assert.ok(s.spendCsv!(t.rows, 'task').includes('"fix, the ""build""",1,200,100,0.000025'));
});
