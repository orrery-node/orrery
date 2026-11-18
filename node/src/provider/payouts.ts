// What a node has paid out to its wallet, kept in its folder one transaction a line: when, how much, from how many
// channels, and the transaction. The node's log says each payout as it goes; this is what lets `provider status` say
// when the last one landed and what the last day came to, across restarts, without reading the log or the chain.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { usd } from '../pricing.ts';

export type Payout = { at: number; units: string; channels: number; tx: string };

export function appendPayout(path: string, p: Payout, rollBytes = 1_000_000): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= rollBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: p.at, units: p.units, channels: p.channels, tx: p.tx })}\n`);
  } catch {
    // the log line already said it
  }
}

export function readPayouts(path: string): Payout[] {
  const text = [`${path}.1`, path].filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8')).join('\n');
  return text.split('\n').flatMap((line) => {
    try {
      const p = JSON.parse(line) as Payout;
      return typeof p.at === 'number' && typeof p.units === 'string' && /^\d+$/.test(p.units) && typeof p.tx === 'string' ? [p] : [];
    } catch {
      return [];
    }
  });
}

export type PayoutSummary = { last: Payout; day: { units: string; count: number } };

/** The last payout and what the last 24 hours came to; null when the node has paid nothing out yet. */
export function payoutSummary(list: Payout[], now = Date.now()): PayoutSummary | null {
  if (!list.length) return null;
  const last = list.reduce((a, b) => (b.at >= a.at ? b : a));
  const day = list.filter((p) => now - p.at <= 86_400_000);
  return { last, day: { units: day.reduce((n, p) => n + BigInt(p.units), 0n).toString(), count: day.length } };
}

/** The two lines `provider status` prints under what is waiting:
 *   last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2…
 *   paid out, last 24 h   $0.120000 in 3 payouts
 * and, before the first one, a line that says there has been none yet. */
export function payoutLines(s: PayoutSummary | null, now = Date.now()): string[] {
  if (!s) return ['  last payout           none yet'];
  const ms = Math.max(0, now - s.last.at);
  const ago = ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
  const when = new Date(s.last.at).toISOString();
  const at = ms < 86_400_000 ? `${when.slice(11, 19)} UTC` : `${when.slice(0, 10)} ${when.slice(11, 16)} UTC`;
  return [
    `  last payout           $${usd(BigInt(s.last.units))} to your wallet ${ago} ago (${at})  tx ${s.last.tx.slice(0, 12)}…`,
    `  paid out, last 24 h   $${usd(BigInt(s.day.units))} in ${s.day.count} payout${s.day.count === 1 ? '' : 's'}`,
  ];
}
