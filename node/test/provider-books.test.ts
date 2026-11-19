import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as books from '../src/provider/books.ts';

describe('a node’s books for one UTC day', () => {
  const fns = books as unknown as {
    utcDay?: (ms: number) => string;
    dayBooksLine?: (day: string, served: { at: number; cost: string }[], payouts: { at: number; units: string; channels: number; tx: string }[], held: { at: number; units: string; tx: string } | null) => string | null;
  };
  const at = (iso: string) => Date.parse(iso);

  it('names the UTC day of a moment', () => {
    assert.equal(fns.utcDay?.(at('2026-11-18T23:59:59.999Z')), '2026-11-18');
    assert.equal(fns.utcDay?.(at('2026-11-19T00:00:00Z')), '2026-11-19');
  });

  it('says what the day billed, what it paid out and what the wallet then held, counting only that day', () => {
    assert.equal(typeof fns.dayBooksLine, 'function', 'books.ts writes the line');
    const served = [
      { at: at('2026-11-17T23:59:59Z'), cost: '0.900000' },
      { at: at('2026-11-18T00:00:00Z'), cost: '0.000031' },
      { at: at('2026-11-18T12:00:00Z'), cost: '0.038881' },
      { at: at('2026-11-19T00:00:00Z'), cost: '0.500000' },
    ];
    const payouts = [
      { at: at('2026-11-18T09:00:00Z'), units: '50123', channels: 2, tx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { at: at('2026-11-18T21:00:00Z'), units: '69877', channels: 1, tx: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      { at: at('2026-11-19T01:00:00Z'), units: '1', channels: 1, tx: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
    ];
    const held = { at: at('2026-11-18T21:00:03Z'), units: '1412500', tx: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
    assert.equal(fns.dayBooksLine!('2026-11-18', served, payouts, held), 'books for 2026-11-18 (UTC): 2 answers, $0.038912 billed; 2 payouts, $0.120000 to your wallet; it held $1.412500 after the last, per the chain');
    assert.equal(fns.dayBooksLine!('2026-11-18', served, payouts, { ...held, tx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), 'books for 2026-11-18 (UTC): 2 answers, $0.038912 billed; 2 payouts, $0.120000 to your wallet');
    assert.equal(fns.dayBooksLine!('2026-11-17', served, payouts, held), 'books for 2026-11-17 (UTC): 1 answer, $0.900000 billed; no payout');
    assert.equal(fns.dayBooksLine!('2026-11-16', served, payouts, held), null);
    assert.equal(fns.dayBooksLine!('not a day', served, payouts, held), null);
  });

  it('lays out the books day by day over a window, newest first, with the total under them', () => {
    const b = books as unknown as { booksByDay?: (s: unknown[], p: unknown[], ms: number, now: number) => unknown; booksByDayLines?: (x: unknown) => string[] };
    assert.equal(typeof b.booksByDay, 'function', 'books.ts lays them out');
    const now = at('2026-11-19T04:00:00Z');
    const served = [
      { at: at('2026-11-10T12:00:00Z'), cost: '9.000000' },
      { at: at('2026-11-18T01:00:00Z'), cost: '0.000031' },
      { at: at('2026-11-18T13:00:00Z'), cost: '0.038881' },
      { at: at('2026-11-19T03:00:00Z'), cost: '0.000423' },
    ];
    const payouts = [{ at: at('2026-11-18T21:00:00Z'), units: '120000', channels: 2, tx: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, { at: at('2026-11-17T09:00:00Z'), units: '50000', channels: 1, tx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }];
    assert.deepEqual(b.booksByDayLines!(b.booksByDay!(served, payouts, 7 * 86_400_000, now)), [
      'day (UTC)       answers       billed   payouts     paid out',
      '2026-11-19            1    $0.000423         0    $0.000000',
      '2026-11-18            2    $0.038912         1    $0.120000',
      '2026-11-17            0    $0.000000         1    $0.050000',
      'total                 3    $0.039335         2    $0.170000',
    ]);
    const csv = (books as unknown as { booksByDayCsv?: (x: unknown) => string }).booksByDayCsv;
    assert.equal(typeof csv, 'function', 'books.ts writes the CSV');
    assert.equal(csv!(b.booksByDay!(served, payouts, 7 * 86_400_000, now)), 'day_utc,answers,billed_usdc,payouts,paid_out_usdc\n2026-11-19,1,0.000423,0,0.000000\n2026-11-18,2,0.038912,1,0.120000\n2026-11-17,0,0.000000,1,0.050000');
  });

  it('writes the payouts it checked as CSV, with the whole transaction and what the chain said', async () => {
    const { payoutsCsv } = (await import('../src/provider/payouts.ts')) as unknown as { payoutsCsv?: (rows: unknown[]) => string };
    assert.equal(typeof payoutsCsv, 'function', 'payouts.ts writes the CSV');
    const p = (at: string, units: string, tx: string) => ({ at: at.length ? Date.parse(at) : 0, units, channels: 1, tx });
    assert.equal(payoutsCsv!([
      { p: p('2026-11-18T14:05:11Z', '50123', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), chain: { state: 'landed', units: 50_123n }, after: 1_250_123n },
      { p: p('2026-11-18T13:05:11Z', '69877', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'), chain: { state: 'missing' }, after: null },
      { p: p('2026-11-18T12:05:11Z', '1000', 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'), chain: null, after: null },
    ]), 'time_utc,paid_out_usdc,channels,tx,on_chain,arrived_usdc,wallet_after_usdc\n'
      + '2026-11-18 14:05:11,0.050123,1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,landed,0.050123,1.250123\n'
      + '2026-11-18 13:05:11,0.069877,1,BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB,missing,,\n'
      + '2026-11-18 12:05:11,0.001000,1,CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC,unchecked,,');
  });

  it('keeps each closed day once, and its kept totals stand in where the rolled-over logs no longer reach', async () => {
    const k = books as unknown as { dayToKeep?: (d: string, s: unknown[], p: unknown[]) => unknown; keepDay?: (path: string, d: unknown) => boolean; readDays?: (path: string) => unknown[]; booksByDay: (s: unknown[], p: unknown[], ms: number, now: number, kept?: unknown[]) => { rows: { day: string; answers: number }[]; total: { answers: number; paid: bigint } } };
    assert.equal(typeof k.keepDay, 'function', 'books.ts keeps closed days');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-days-')), 'days.jsonl');
    const served = [{ at: at('2026-11-17T10:00:00Z'), cost: '0.000010' }, { at: at('2026-11-17T11:00:00Z'), cost: '0.000020' }, { at: at('2026-11-19T01:00:00Z'), cost: '0.000005' }];
    const payouts = [{ at: at('2026-11-17T12:00:00Z'), units: '30', channels: 1, tx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }];
    const d17 = k.dayToKeep!('2026-11-17', served, payouts);
    assert.deepEqual(d17, { day: '2026-11-17', answers: 2, billed: '30', payouts: 1, paid: '30' });
    assert.equal(k.dayToKeep!('2026-11-16', served, payouts), null);
    assert.equal(k.keepDay!(path, d17), true);
    assert.equal(k.keepDay!(path, { ...(d17 as object), answers: 99 }), false, 'a kept day is kept once');
    assert.deepEqual(k.readDays!(path), [d17]);
    const now = at('2026-11-19T04:00:00Z');
    // The logs rolled over and now start on the 19th: the 17th comes from what was kept.
    const rolled = served.slice(2);
    const b = k.booksByDay(rolled, [], 7 * 86_400_000, now, k.readDays!(path));
    assert.deepEqual(b.rows.map((r) => [r.day, r.answers]), [['2026-11-19', 1], ['2026-11-17', 2]]);
    assert.equal(b.total.answers, 3);
    assert.equal(b.total.paid, 30n);
    // While the logs still reach back past the day's start, they speak for it.
    const full = k.booksByDay([{ at: at('2026-11-16T23:00:00Z'), cost: '0.000001' }, ...served], payouts, 7 * 86_400_000, now, [{ day: '2026-11-17', answers: 99, billed: '0', payouts: 0, paid: '0' }]);
    assert.equal(full.rows.find((r) => r.day === '2026-11-17')?.answers, 2);
  });

  it('posts the day’s line to the notify webhook as the log says it, with the day’s totals in USDC', () => {
    const notice = (books as unknown as { booksNotice?: (node: string, line: string, d: unknown) => { text: string; content: string; books: Record<string, unknown> | null } }).booksNotice;
    assert.equal(typeof notice, 'function', 'books.ts writes the notice');
    const line = 'books for 2026-11-18 (UTC): 1,312 answers, $0.038912 billed; 3 payouts, $0.120000 to your wallet';
    const n = notice!('Kestrel GPU Co-op', line, { day: '2026-11-18', answers: 1312, billed: '38912', payouts: 3, paid: '120000' });
    assert.equal(n.text, `Kestrel GPU Co-op: ${line}`);
    assert.equal(n.content, n.text);
    assert.deepEqual(n.books, { day: '2026-11-18', answers: 1312, billed: '0.038912', payouts: 3, paidOut: '0.120000' });
    assert.equal(notice!('Kestrel GPU Co-op', line, null).books, null);
  });
});
