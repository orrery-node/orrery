// A node's books for one UTC day, said once in its log just after midnight UTC: what it billed, what it paid out to
// the wallet, and what the wallet held after the last payout, per the chain. Read from the files the node keeps
// (served.jsonl, payouts.jsonl, held.json), so it costs no RPC call and an operator who only reads the log sees the day.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { usd } from '../pricing.ts';
import type { Held, Payout } from './payouts.ts';

const DAY = 86_400_000;

/** A closed UTC day's totals, kept one line a day in days.jsonl beside the logs. The answer and payout logs roll over
 * on a busy node; this file does not, so the books by day reach back past what the logs still hold. */
export type DayKept = { day: string; answers: number; billed: string; payouts: number; paid: string };

export function readDays(path: string): DayKept[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try {
      const d = JSON.parse(line) as DayKept;
      return /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isInteger(d.answers) && Number.isInteger(d.payouts) && /^\d+$/.test(d.billed) && /^\d+$/.test(d.paid) ? [d] : [];
    } catch {
      return [];
    }
  });
}

/** Keeps a closed day once; a day already kept is left as it is. */
export function keepDay(path: string, d: DayKept): boolean {
  if (readDays(path).some((k) => k.day === d.day)) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ day: d.day, answers: d.answers, billed: d.billed, payouts: d.payouts, paid: d.paid })}\n`);
    return true;
  } catch {
    return false;
  }
}

/** "2026-11-18" for a moment, in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const toUnits = (cost: string): bigint => {
  const [w, f = ''] = cost.split('.');
  return /^\d+$/.test(w) && /^\d*$/.test(f) ? BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6)) : 0n;
};

/** One line for the day, or null when nothing was served or paid out in it:
 *   books for 2026-11-18 (UTC): 1,312 answers, $0.038912 billed (40 at your holder price, $0.000412 under list); 3 payouts, $0.120000 to your wallet; it held $1.412500 after the last, per the chain
 * The part in brackets is there when some answers went at the holder price (the log keeps `saved` on each), and, given
 * what each model is for in the node's listing, when the day had more than one kind of work: what each kind billed,
 *   … $0.038912 billed (by kind: chat 1,290, $0.032000 · image 2, $0.006002 · speech 20, $0.000910); …
 */
export function dayBooksLine(day: string, served: { at: number; cost: string; saved?: string; model?: string }[], payouts: Payout[], held: Held | null, kindOf?: (model: string) => string): string | null {
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
  const atHolder = answers.filter((t) => typeof t.saved === 'string');
  const under = atHolder.reduce((n, t) => n + toUnits(t.saved!), 0n);
  const kinds = kindOf ? dayKinds(day, answers, kindOf) : [];
  const byKind = kinds.length > 1 ? `by kind: ${kinds.map((k) => `${k.kind} ${k.answers.toLocaleString('en-US')}, $${usd(k.units)}`).join(' · ')}` : '';
  const notes = [...(atHolder.length ? [`${atHolder.length.toLocaleString('en-US')} at your holder price, $${usd(under)} under list`] : []), ...(byKind ? [byKind] : [])];
  const a = `${answers.length.toLocaleString('en-US')} answer${answers.length === 1 ? '' : 's'}, $${usd(billed)} billed${notes.length ? ` (${notes.join('; ')})` : ''}`;
  const p = paid.length ? `${paid.length} payout${paid.length === 1 ? '' : 's'}, $${usd(out)} to your wallet` : 'no payout';
  return `books for ${day} (UTC): ${a}; ${p}${after}`;
}

/** What each kind of work billed in a UTC day, by what each model is for in the node's listing, most first. */
export function dayKinds(day: string, served: { at: number; cost: string; model?: string }[], kindOf: (model: string) => string): { kind: string; answers: number; units: bigint }[] {
  const start = Date.parse(`${day}T00:00:00Z`);
  const kinds = new Map<string, { answers: number; units: bigint }>();
  for (const t of served) {
    if (!(t.at >= start && t.at < start + DAY)) continue;
    const k = kindOf(t.model ?? '');
    const e = kinds.get(k) ?? { answers: 0, units: 0n };
    e.answers += 1;
    e.units += toUnits(t.cost);
    kinds.set(k, e);
  }
  return [...kinds].map(([kind, e]) => ({ kind, ...e })).sort((a, b) => (a.units === b.units ? a.kind.localeCompare(b.kind) : a.units > b.units ? -1 : 1));
}

export type DayBooks = { day: string; answers: number; billed: bigint; payouts: number; paid: bigint };

/** The books day by day (UTC) over a window: what each day billed, from the node's log of answers, and what it paid
 * out to the wallet, from its payouts. Newest day first; days with neither are left out. */
export function booksByDay(served: { at: number; cost: string }[], payouts: Payout[], sinceMs: number, now = Date.now(), kept: DayKept[] = []): { rows: DayBooks[]; total: DayBooks } {
  const days = new Map<string, DayBooks>();
  const of = (at: number) => {
    const day = utcDay(at);
    const r = days.get(day) ?? { day, answers: 0, billed: 0n, payouts: 0, paid: 0n };
    days.set(day, r);
    return r;
  };
  for (const t of served) {
    if (now - t.at > sinceMs) continue;
    const r = of(t.at);
    r.answers += 1;
    r.billed += toUnits(t.cost);
  }
  for (const p of payouts) {
    if (now - p.at > sinceMs) continue;
    const r = of(p.at);
    r.payouts += 1;
    r.paid += BigInt(p.units);
  }
  // A kept day stands in for the logs where they no longer reach back to its start, after a roll-over.
  let logsFrom = Infinity;
  for (const t of served) if (t.at < logsFrom) logsFrom = t.at;
  for (const p of payouts) if (p.at < logsFrom) logsFrom = p.at;
  for (const k of kept) {
    const start = Date.parse(`${k.day}T00:00:00Z`);
    if (start + DAY <= now - sinceMs || (days.has(k.day) && logsFrom <= start)) continue;
    days.set(k.day, { day: k.day, answers: k.answers, billed: BigInt(k.billed), payouts: k.payouts, paid: BigInt(k.paid) });
  }
  const rows = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  const total = rows.reduce((t, r) => ({ day: 'total', answers: t.answers + r.answers, billed: t.billed + r.billed, payouts: t.payouts + r.payouts, paid: t.paid + r.paid }), { day: 'total', answers: 0, billed: 0n, payouts: 0, paid: 0n } as DayBooks);
  return { rows, total };
}

/** The closed day's totals from the logs, to keep: null when the logs hold nothing for it. */
export function dayToKeep(day: string, served: { at: number; cost: string }[], payouts: Payout[]): DayKept | null {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  const inDay = (at: number) => at >= start && at < start + DAY;
  const a = served.filter((t) => inDay(t.at)), p = payouts.filter((x) => inDay(x.at));
  if (!a.length && !p.length) return null;
  return { day, answers: a.length, billed: a.reduce((n, t) => n + toUnits(t.cost), 0n).toString(), payouts: p.length, paid: p.reduce((n, x) => n + BigInt(x.units), 0n).toString() };
}

/** What the node posts to its `notify` webhook just after midnight UTC: the day's line from its log, under `text` and
 * `content` as a payout's notice has it, and the day's totals under `books` in USDC. */
export function booksNotice(node: string, line: string, d: DayKept | null, kinds: { kind: string; answers: number; units: bigint }[] = []): { text: string; content: string; books: { day: string; answers: number; billed: string; payouts: number; paidOut: string; kinds?: { kind: string; answers: number; billed: string }[] } | null } {
  const text = `${node}: ${line}`;
  // With more than one kind of work in the day, a script reads what each billed here rather than out of the text.
  const byKind = kinds.length > 1 ? { kinds: kinds.map((k) => ({ kind: k.kind, answers: k.answers, billed: usd(k.units) })) } : {};
  return { text, content: text, books: d ? { day: d.day, answers: d.answers, billed: usd(BigInt(d.billed)), payouts: d.payouts, paidOut: usd(BigInt(d.paid)), ...byKind } : null };
}

/** `provider earnings --by day`:
 *   day (UTC)       answers       billed   payouts     paid out
 *   2026-11-19           27    $0.000423         1    $0.000423 */
export function booksByDayLines(b: { rows: DayBooks[]; total: DayBooks }, unit: 'day' | 'month' = 'day'): string[] {
  const row = (r: DayBooks) => `${r.day.padEnd(14)} ${r.answers.toLocaleString('en-US').padStart(8)}  ${`$${usd(r.billed)}`.padStart(11)}  ${String(r.payouts).padStart(8)}  ${`$${usd(r.paid)}`.padStart(11)}`;
  return [`${`${unit} (UTC)`.padEnd(14)} ${'answers'.padStart(8)}  ${'billed'.padStart(11)}  ${'payouts'.padStart(8)}  ${'paid out'.padStart(11)}`, ...b.rows.map(row), row(b.total)];
}

/** The same books as CSV, for a spreadsheet or an accountant: one row a UTC day (or month), amounts in USDC, no total row. */
export function booksByDayCsv(b: { rows: DayBooks[] }, unit: 'day' | 'month' = 'day'): string {
  return [`${unit}_utc,answers,billed_usdc,payouts,paid_out_usdc`, ...b.rows.map((r) => `${r.day},${r.answers},${usd(r.billed)},${r.payouts},${usd(r.paid)}`)].join('\n');
}

/** This UTC month so far, from the same files as the books by day (the days kept in days.jsonl included): the line the
 * console shows under its books. A month with nothing yet comes back with zeros. */
export function monthSoFar(served: { at: number; cost: string }[], payouts: Payout[], now = Date.now(), kept: DayKept[] = []): DayBooks {
  const month = utcDay(now).slice(0, 7);
  const start = Date.parse(`${month}-01T00:00:00Z`);
  const row = booksByMonth(booksByDay(served, payouts, now - start, now, kept)).rows.find((r) => r.day === month);
  return row ?? { day: month, answers: 0, billed: 0n, payouts: 0, paid: 0n };
}

/** The month that just ended, in one line of the node's log and to its notify webhook; null for a month with nothing:
 * "books for November 2026 (UTC): 1,312 answers, $0.038912 billed; 3 payouts, $0.120000 paid out to your wallet" */
export function monthBooksLine(m: DayBooks): string | null {
  if (!m.answers && !m.payouts) return null;
  const name = new Date(`${m.day}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `books for ${name} (UTC): ${m.answers.toLocaleString('en-US')} answer${m.answers === 1 ? '' : 's'}, $${usd(m.billed)} billed; ${m.payouts} payout${m.payouts === 1 ? '' : 's'}, $${usd(m.paid)} paid out to your wallet`;
}

/** What the notify webhook gets when a month ends: the line, and the month's totals for a script. */
export function monthNotice(node: string, line: string, m: DayBooks): { text: string; content: string; month: { month: string; answers: number; billed: string; payouts: number; paidOut: string } } {
  const text = `${node}: ${line}`;
  return { text, content: text, month: { month: m.day, answers: m.answers, billed: usd(m.billed), payouts: m.payouts, paidOut: usd(m.paid) } };
}

/** "November so far (UTC): 1,312 answers, $0.038912 billed; 3 payouts, $0.120000 paid out to your wallet" */
export function monthSentence(m: DayBooks): string {
  const name = new Date(`${m.day}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${name} so far (UTC): ${m.answers.toLocaleString('en-US')} answer${m.answers === 1 ? '' : 's'}, $${usd(m.billed)} billed; ${m.payouts} payout${m.payouts === 1 ? '' : 's'}, $${usd(m.paid)} paid out to your wallet`;
}

/** The books by day folded into UTC calendar months, for the accounts: `provider earnings --by month`. Newest first;
 * each row is its days added up, so a month the logs no longer reach still counts the days kept in days.jsonl. */
export function booksByMonth(b: { rows: DayBooks[]; total: DayBooks }): { rows: DayBooks[]; total: DayBooks } {
  const months = new Map<string, DayBooks>();
  for (const r of b.rows) {
    const key = r.day.slice(0, 7);
    const m = months.get(key) ?? { day: key, answers: 0, billed: 0n, payouts: 0, paid: 0n };
    m.answers += r.answers;
    m.billed += r.billed;
    m.payouts += r.payouts;
    m.paid += r.paid;
    months.set(key, m);
  }
  return { rows: [...months.values()].sort((x, y) => (x.day < y.day ? 1 : -1)), total: b.total };
}
