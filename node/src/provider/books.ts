// A node's books for one UTC day, said once in its log just after midnight UTC: what it billed, what it paid out to
// the wallet, and what the wallet held after the last payout, per the chain. Read from the files the node keeps
// (served.jsonl, payouts.jsonl, held.json), so it costs no RPC call and an operator who only reads the log sees the day.
import { usd } from '../pricing.ts';
import type { Held, Payout } from './payouts.ts';

const DAY = 86_400_000;

/** "2026-11-18" for a moment, in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const toUnits = (cost: string): bigint => {
  const [w, f = ''] = cost.split('.');
  return /^\d+$/.test(w) && /^\d*$/.test(f) ? BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6)) : 0n;
};

/** One line for the day, or null when nothing was served or paid out in it:
 *   books for 2026-11-18 (UTC): 1,312 answers, $0.038912 billed; 3 payouts, $0.120000 to your wallet; it held $1.412500 after the last, per the chain */
export function dayBooksLine(day: string, served: { at: number; cost: string }[], payouts: Payout[], held: Held | null): string | null {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  const inDay = (at: number) => at >= start && at < start + DAY;
  const answers = served.filter((t) => inDay(t.at));
  const paid = payouts.filter((p) => inDay(p.at));
  if (!answers.length && !paid.length) return null;
  const billed = answers.reduce((n, t) => n + toUnits(t.cost), 0n);
  const out = paid.reduce((n, p) => n + BigInt(p.units), 0n);
  const lastPaid = paid.reduce<Payout | null>((a, p) => (!a || p.at >= a.at ? p : a), null);
  const after = held && lastPaid && held.tx === lastPaid.tx ? `; it held $${usd(BigInt(held.units))} after the last, per the chain` : '';
  const a = `${answers.length.toLocaleString('en-US')} answer${answers.length === 1 ? '' : 's'}, $${usd(billed)} billed`;
  const p = paid.length ? `${paid.length} payout${paid.length === 1 ? '' : 's'}, $${usd(out)} to your wallet` : 'no payout';
  return `books for ${day} (UTC): ${a}; ${p}${after}`;
}

export type DayBooks = { day: string; answers: number; billed: bigint; payouts: number; paid: bigint };

/** The books day by day (UTC) over a window: what each day billed, from the node's log of answers, and what it paid
 * out to the wallet, from its payouts. Newest day first; days with neither are left out. */
export function booksByDay(served: { at: number; cost: string }[], payouts: Payout[], sinceMs: number, now = Date.now()): { rows: DayBooks[]; total: DayBooks } {
  const days = new Map<string, DayBooks>();
  const total: DayBooks = { day: 'total', answers: 0, billed: 0n, payouts: 0, paid: 0n };
  const of = (at: number) => {
    const day = utcDay(at);
    const r = days.get(day) ?? { day, answers: 0, billed: 0n, payouts: 0, paid: 0n };
    days.set(day, r);
    return r;
  };
  for (const t of served) {
    if (now - t.at > sinceMs) continue;
    for (const r of [of(t.at), total]) {
      r.answers += 1;
      r.billed += toUnits(t.cost);
    }
  }
  for (const p of payouts) {
    if (now - p.at > sinceMs) continue;
    for (const r of [of(p.at), total]) {
      r.payouts += 1;
      r.paid += BigInt(p.units);
    }
  }
  return { rows: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)), total };
}

/** `provider earnings --by day`:
 *   day (UTC)       answers       billed   payouts     paid out
 *   2026-11-19           27    $0.000423         1    $0.000423 */
export function booksByDayLines(b: { rows: DayBooks[]; total: DayBooks }): string[] {
  const row = (r: DayBooks) => `${r.day.padEnd(14)} ${r.answers.toLocaleString('en-US').padStart(8)}  ${`$${usd(r.billed)}`.padStart(11)}  ${String(r.payouts).padStart(8)}  ${`$${usd(r.paid)}`.padStart(11)}`;
  return [`${'day (UTC)'.padEnd(14)} ${'answers'.padStart(8)}  ${'billed'.padStart(11)}  ${'payouts'.padStart(8)}  ${'paid out'.padStart(11)}`, ...b.rows.map(row), row(b.total)];
}

/** The same books as CSV, for a spreadsheet or an accountant: one row a UTC day, amounts in USDC, no total row. */
export function booksByDayCsv(b: { rows: DayBooks[] }): string {
  return ['day_utc,answers,billed_usdc,payouts,paid_out_usdc', ...b.rows.map((r) => `${r.day},${r.answers},${usd(r.billed)},${r.payouts},${usd(r.paid)}`)].join('\n');
}
