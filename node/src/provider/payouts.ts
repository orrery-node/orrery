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
      return typeof p.at === 'number' && typeof p.units === 'string' && /^\d+$/.test(p.units) && typeof p.tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(p.tx) && Number.isInteger(p.channels) ? [p] : [];
    } catch {
      return [];
    }
  });
}

export type PayoutSummary = { last: Payout; day: { units: string; count: number }; recent: Payout[] };

/** The last payout and what the last 24 hours came to; null when the node has paid nothing out yet. */
export function payoutSummary(list: Payout[], now = Date.now()): PayoutSummary | null {
  if (!list.length) return null;
  const last = list.reduce((a, b) => (b.at >= a.at ? b : a));
  const day = list.filter((p) => now - p.at <= 86_400_000);
  const recent = list.slice().sort((a, b) => b.at - a.at).slice(0, 12);
  return { last, day: { units: day.reduce((n, p) => n + BigInt(p.units), 0n).toString(), count: day.length }, recent };
}

/** The two lines `provider status` prints under what is waiting:
 *   last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2…
 *   paid out, last 24 h   $0.120000 in 3 payouts
 * and, before the first one kept, a line that says so: none yet, or none kept since this node began keeping them when
 * the listing was paid out on chain before. */
export function payoutLines(s: PayoutSummary | null, now = Date.now(), paidBefore = false): string[] {
  if (!s) return [paidBefore ? '  last payout           none recorded here yet; this listing was paid out on chain before' : '  last payout           none yet'];
  const ms = Math.max(0, now - s.last.at);
  const ago = ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
  const when = new Date(s.last.at).toISOString();
  const at = ms < 86_400_000 ? `${when.slice(11, 19)} UTC` : `${when.slice(0, 10)} ${when.slice(11, 16)} UTC`;
  return [
    `  last payout           $${usd(BigInt(s.last.units))} to your wallet ${ago} ago (${at})  tx ${s.last.tx.slice(0, 12)}…`,
    `  paid out, last 24 h   $${usd(BigInt(s.day.units))} in ${s.day.count} payout${s.day.count === 1 ? '' : 's'}`,
  ];
}

/** The console's payout rows: the latest payouts, newest first, each with its transaction (whole in the title), then
 * the last 24 hours. Its source goes into the page, so it uses nothing from outside itself and names no local function
 * (tsx would wrap one in a helper the browser does not have); what it prints is digits
 * and base58, which readPayouts checks. */
export function payoutRows(p: { day: { units: string; count: number }; recent: { at: number; units: string; channels: number; tx: string }[] } | null): string {
  if (!p || !p.recent.length) return '<tr class=empty><td colspan=4>None recorded here yet. Each payout this node sends to your wallet is listed here, with its transaction.</td></tr>';
  return p.recent.map((r) => '<tr><td>' + new Date(r.at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC</td><td class=go>$' + (Number(r.units) / 1e6).toFixed(6) + '</td><td>' + r.channels + '</td><td title="' + r.tx + '">' + r.tx.slice(0, 12) + '…</td></tr>').join('')
    + '<tr><td>last 24 h</td><td class=go>$' + (Number(p.day.units) / 1e6).toFixed(6) + '</td><td colspan=2>' + p.day.count + ' payout' + (p.day.count === 1 ? '' : 's') + '</td></tr>';
}

/** What reached the wallet in the window `provider earnings` looks at:
 *   paid out: $0.120000 to your wallet in 2 payouts in the last 24h, the last 12 min ago (tx 5Gh4kQp9xTn2…)
 * or that none did and when the last one was; null when the node has kept no payout yet. */
export function paidOutLine(list: Payout[], sinceMs: number, since: string, now = Date.now()): string | null {
  if (!list.length) return null;
  const inside = list.filter((p) => now - p.at <= sinceMs).sort((a, b) => a.at - b.at);
  const last = list.reduce((a, b) => (b.at >= a.at ? b : a));
  if (!inside.length) return `paid out: none in the last ${since}; the last was ${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const units = inside.reduce((n, p) => n + BigInt(p.units), 0n);
  const newest = inside[inside.length - 1];
  const ms = Math.max(0, now - newest.at);
  const ago = ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
  return `paid out: $${usd(units)} to your wallet in ${inside.length} payout${inside.length === 1 ? '' : 's'} in the last ${since}, the last ${ago} ago (tx ${newest.tx.slice(0, 12)}…)`;
}

export type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
export type PayoutTx = { meta: { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null } | null;
export type Landed = { state: 'landed'; units: bigint } | { state: 'failed' } | { state: 'missing' };

/** What a payout's transaction put into the wallet's USDC account, from the chain's own record of it: the account's
 * balance after the transaction minus before (an account the payout opened counts from zero). */
export function landedUnits(tx: PayoutTx, wallet: string, mint: string): Landed {
  if (!tx?.meta) return { state: 'missing' };
  if (tx.meta.err) return { state: 'failed' };
  const of = (list: TokenBalance[] | null | undefined) => (list ?? []).find((b) => b.owner === wallet && b.mint === mint);
  const after = of(tx.meta.postTokenBalances);
  const before = of(tx.meta.preTokenBalances);
  return { state: 'landed', units: (after ? BigInt(after.uiTokenAmount.amount) : 0n) - (before ? BigInt(before.uiTokenAmount.amount) : 0n) };
}

/** `provider payouts`: each payout this node kept, newest first, next to what the chain says reached the wallet,
 *   2026-11-18 14:05:11 UTC  $0.050123  2 channels  tx 5GhKq2abcdef…  arrived $0.050123
 * then a line that adds them up and says whether every one arrived as kept. */
export function payoutCheckLines(name: string, rows: { p: Payout; chain: Landed | null }[], total: number): string[] {
  if (!rows.length) return [`"${name}" has kept no payout yet. Each payout it sends to your wallet is kept in payouts.jsonl in its folder, with its transaction.`];
  const said = (c: Landed | null, p: Payout) => {
    if (!c) return 'not checked';
    if (c.state === 'missing') return 'the RPC has no record of it';
    if (c.state === 'failed') return 'failed on chain';
    return c.units === BigInt(p.units) ? `arrived $${usd(c.units)}` : `arrived $${usd(c.units)}, kept here as $${usd(BigInt(p.units))}`;
  };
  const lines = rows.map(({ p, chain }) => `  ${new Date(p.at).toISOString().slice(0, 19).replace('T', ' ')} UTC  $${usd(BigInt(p.units))}  ${p.channels} channel${p.channels === 1 ? ' ' : 's'}  tx ${p.tx.slice(0, 12)}…  ${said(chain, p)}`);
  const head = `"${name}", the last ${rows.length} of ${total} payout${total === 1 ? '' : 's'} kept here, each checked against the chain`;
  const checked = rows.filter((r) => r.chain);
  if (!checked.length) return [head, ...lines, 'the RPC did not answer; nothing was checked'];
  const asKept = checked.filter((r) => r.chain!.state === 'landed' && (r.chain as { units: bigint }).units === BigInt(r.p.units));
  const sum = asKept.reduce((n, r) => n + BigInt(r.p.units), 0n);
  const rest = checked.length - asKept.length;
  const unchecked = rows.length - checked.length;
  return [head, ...lines, `${asKept.length} of ${checked.length} arrived in your wallet as kept here, $${usd(sum)} in all${rest ? `; ${rest} did not (see above)` : ''}${unchecked ? `; ${unchecked} not checked, the RPC did not answer` : ''}`];
}
