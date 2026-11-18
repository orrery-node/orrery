import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as payouts from '../src/provider/payouts.ts';
import * as own from '../src/provider/console.ts';
import { appendPayout, payoutLines, payoutSummary, readPayouts } from '../src/provider/payouts.ts';

describe('what a node has paid out to its wallet', () => {
  it('keeps each payout a line and reads them back, across the rolled file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-payouts-')), 'payouts.jsonl');
    appendPayout(path, { at: 1_000, units: '50123', channels: 1, tx: 'A'.repeat(88) }, 1);
    appendPayout(path, { at: 2_000, units: '70000', channels: 2, tx: 'B'.repeat(88) }, 1);
    assert.deepEqual(readPayouts(path).map((p) => [p.at, p.units, p.channels]), [[1_000, '50123', 1], [2_000, '70000', 2]]);
    assert.deepEqual(readPayouts(join(tmpdir(), 'orrery-nowhere', 'payouts.jsonl')), []);
  });

  it('sums the last 24 hours and finds the last payout, whatever order the lines are in', () => {
    const now = 100 * 86_400_000;
    const list = [
      { at: now - 2 * 86_400_000, units: '900000', channels: 1, tx: 'old' },
      { at: now - 720_000, units: '50123', channels: 1, tx: '5GhKq2abcdefXYZ' },
      { at: now - 3_600_000, units: '69877', channels: 2, tx: 'mid' },
    ];
    assert.deepEqual(payoutSummary(list, now), { last: list[1], day: { units: '120000', count: 2 }, recent: [list[1], list[2], list[0]] });
    assert.equal(payoutSummary([], now), null);
  });

  it('says when money last landed and what the day came to, or that none has yet', () => {
    const now = Date.parse('2026-11-18T14:17:11Z');
    const s = { last: { at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 1, tx: '5GhKq2abcdefXYZ' }, day: { units: '120000', count: 3 }, recent: [] };
    assert.deepEqual(payoutLines(s, now), [
      '  last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2abcdef…',
      '  paid out, last 24 h   $0.120000 in 3 payouts',
    ]);
    const old = { last: { ...s.last, at: Date.parse('2026-11-15T09:30:00Z') }, day: { units: '0', count: 0 }, recent: [] };
    assert.deepEqual(payoutLines(old, now), [
      '  last payout           $0.050123 to your wallet 3 days ago (2026-11-15 09:30 UTC)  tx 5GhKq2abcdef…',
      '  paid out, last 24 h   $0.000000 in 0 payouts',
    ]);
    assert.deepEqual(payoutLines(null, now), ['  last payout           none yet']);
    assert.deepEqual(payoutLines(null, now, true), ['  last payout           none recorded here yet; this listing was paid out on chain before']);
  });

  it('lists the latest payouts for the console, each with its transaction, and the last day under them', () => {
    const rows = (payouts as unknown as { payoutRows?: (p: unknown) => string }).payoutRows;
    assert.equal(typeof rows, 'function', 'payouts.ts renders the console rows');
    const tx = '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2abcdefXYZ';
    const p = { last: { at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 2, tx }, day: { units: '120000', count: 3 }, recent: [{ at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 2, tx }] };
    assert.equal(rows!(p), `<tr><td>2026-11-18 14:05:11 UTC</td><td class=go>$0.050123</td><td>2</td><td title="${tx}">5GhKq2abcdef…</td></tr><tr><td>last 24 h</td><td class=go>$0.120000</td><td colspan=2>3 payouts</td></tr>`);
    assert.equal(rows!(null), '<tr class=empty><td colspan=4>None recorded here yet. Each payout this node sends to your wallet is listed here, with its transaction.</td></tr>');
  });

  it('drops a kept line whose transaction is not a signature, so nothing from the file reaches the page as markup', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-payouts-')), 'payouts.jsonl');
    appendPayout(path, { at: 1, units: '1', channels: 1, tx: '<img src=x onerror=alert(1)>' });
    appendPayout(path, { at: 2, units: '2', channels: 1, tx: '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2abcdefXYZ' });
    assert.deepEqual(readPayouts(path).map((x) => x.at), [2]);
  });

  it('says what the last 24 hours billed, from the node’s own log, which a restart does not reset', () => {
    const dayLine = (own as unknown as { dayLine?: (t: unknown) => string }).dayLine;
    assert.equal(typeof dayLine, 'function', 'console.ts writes the line');
    assert.equal(dayLine!({ answers: 1312, usd: '0.038912' }), '  last 24 h             1,312 answers, $0.038912 billed');
    assert.equal(dayLine!({ answers: 1, usd: '0.000029' }), '  last 24 h             1 answer, $0.000029 billed');
    assert.equal(dayLine!({ answers: 0, usd: '0.000000' }), '  last 24 h             no answers');
  });
});
