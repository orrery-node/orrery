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
