// What a node has paid out to its wallet, kept in its folder one transaction a line: when, how much, from how many
// channels, and the transaction. The node's log says each payout as it goes; this is what lets `provider status` say
// when the last one landed and what the last day came to, across restarts, without reading the log or the chain.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { usd } from '../pricing.ts';

export type Payout = { at: number; units: string; channels: number; tx: string };

/** What the wallet's USDC account held right after the last payout the node read back from the chain, with that
 * payout's transaction: kept in held.json beside the payouts so the console shows it across restarts. */
export type Held = { at: number; units: string; tx: string };

export function writeHeld(path: string, h: Held): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ at: h.at, units: h.units, tx: h.tx })}\n`);
  } catch {
    // the log line already said it
  }
}

export function readHeld(path: string): Held | null {
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as Held;
    return typeof h.at === 'number' && typeof h.units === 'string' && /^\d+$/.test(h.units) && typeof h.tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(h.tx) ? { at: h.at, units: h.units, tx: h.tx } : null;
  } catch {
    return null;
  }
}

/** The last notice the node posted to its `notify` webhook and what the webhook answered (null: not reached), kept in
 * notice.json beside the logs so `provider status` and the console can say whether notices are getting through. */
export type NoticeSent = { at: number; what: 'payout' | 'books'; status: number | null };

export function writeNotice(path: string, n: NoticeSent): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ at: n.at, what: n.what, status: n.status })}\n`);
  } catch {
    // the log says a notice that failed
  }
}

export function readNotice(path: string): NoticeSent | null {
  try {
    const n = JSON.parse(readFileSync(path, 'utf8')) as NoticeSent;
    return typeof n.at === 'number' && (n.what === 'payout' || n.what === 'books') && (n.status === null || Number.isInteger(n.status)) ? { at: n.at, what: n.what, status: n.status } : null;
  } catch {
    return null;
  }
}

/** Where the node's notices go and whether the last one got through, in words:
 *   to hooks.slack.com; the last, a payout 5 min ago, got through (HTTP 200) */
export function noticeSentence(host: string, last: NoticeSent | null, now = Date.now()): string {
  if (!last) return `to ${host}; none sent yet (the first goes with the next payout)`;
  const ms = Math.max(0, now - last.at);
  const ago = ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
  const what = last.what === 'payout' ? 'a payout' : 'the day’s books';
  const result = last.status === null ? 'could not reach it' : last.status >= 200 && last.status <= 299 ? `got through (HTTP ${last.status})` : `was refused (HTTP ${last.status}); check the webhook address`;
  return `to ${host}; the last, ${what} ${ago} ago, ${result}`;
}

/** `provider status`, under the wallet:
 *   payout notices        to hooks.slack.com; the last, a payout 5 min ago, got through (HTTP 200) */
export function noticeLine(host: string, last: NoticeSent | null, now = Date.now()): string {
  return `  payout notices        ${noticeSentence(host, last, now)}`;
}

/** `provider status`, under the payouts: what the console shows beside its totals.
 *   in your wallet        $1.412500 after the last payout, per the chain (tx 5GhKq2abcdef…) */
export function walletLine(h: Held): string {
  return `  in your wallet        $${usd(BigInt(h.units))} after the last payout, per the chain (tx ${h.tx.slice(0, 12)}…)`;
}

export function appendPayout(path: string, p: Payout, rollBytes = 10 * 1024 * 1024): void {
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
 * the listing was paid out on chain before. A last payout the node has read back from the chain as kept ends with
 * "arrived, per the chain". */
export function payoutLines(s: (PayoutSummary & { checked?: Record<string, { units: string }> }) | null, now = Date.now(), paidBefore = false): string[] {
  if (!s) return [paidBefore ? '  last payout           none recorded here yet; this listing was paid out on chain before' : '  last payout           none yet'];
  const ms = Math.max(0, now - s.last.at);
  const ago = ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
  const when = new Date(s.last.at).toISOString();
  const at = ms < 86_400_000 ? `${when.slice(11, 19)} UTC` : `${when.slice(0, 10)} ${when.slice(11, 16)} UTC`;
  return [
    `  last payout           $${usd(BigInt(s.last.units))} to your wallet ${ago} ago (${at})  tx ${s.last.tx.slice(0, 12)}…${s.checked?.[s.last.tx]?.units === s.last.units ? '  arrived, per the chain' : ''}`,
    `  paid out, last 24 h   $${usd(BigInt(s.day.units))} in ${s.day.count} payout${s.day.count === 1 ? '' : 's'}`,
  ];
}

export type NextPayout = { due: string; dueChannels: number; below: string; belowChannels: number; floor: string; everySecs: number; first: boolean };

/** What the next payout round will send and what keeps waiting, from each channel's amount not yet redeemed: a channel
 * goes out once it reaches the floor (redeem.minUnits), when its router closes it, or at once for a node's first
 * payout; the rest waits. */
export function nextPayout(channels: { pending: bigint; closing: boolean }[], floor: bigint, everySecs: number, first: boolean): NextPayout {
  let due = 0n, below = 0n, dueChannels = 0, belowChannels = 0;
  for (const c of channels) {
    if (c.pending <= 0n) continue;
    if (c.pending >= floor || c.closing || first) {
      due += c.pending;
      dueChannels++;
    } else {
      below += c.pending;
      belowChannels++;
    }
  }
  return { due: due.toString(), dueChannels, below: below.toString(), belowChannels, floor: floor.toString(), everySecs, first };
}

/** When money next goes to the wallet, said plainly, for `provider status` and the console:
 *   "$0.004211 is waiting in 1 channel. Each pays out once it reaches $0.050000 or its router closes it; this node
 *    checks every 1 min."
 * Its source goes into the console page, so it uses nothing from outside itself and names no local function. */
/** What the last payout round said when it failed, for the console and `provider status`: when, and the chain's own words
 * with what to do about them. Empty once a round goes through. */
export function payoutFailedSentence(f: { at: number; said: string } | null | undefined): string {
  if (!f) return '';
  return 'The last payout round, at ' + new Date(f.at).toISOString().slice(11, 16) + ' UTC, failed: ' + f.said + '. Each round tries again' + (/ safe /.test(f.said) ? '.' : ', and nothing signed to you is lost meanwhile.');
}

/** The webhook notice for a payout round that failed: the console's sentence, and the same as JSON for a script. Sent
 * once when payouts start failing, not every round. */
export function payoutFailedNotice(node: string, f: { at: number; said: string }): { text: string; content: string; payoutFailed: { node: string; at: string; said: string } } {
  const line = `${node}: ${payoutFailedSentence(f)}`;
  return { text: line, content: line, payoutFailed: { node, at: new Date(f.at).toISOString(), said: f.said } };
}

export function nextPayoutSentence(n: { due: string; dueChannels: number; below: string; belowChannels: number; floor: string; everySecs: number; first: boolean } | null | undefined): string {
  if (!n) return '';
  if (n.due === '0' && n.below === '0') return 'Nothing is waiting to be paid out.';
  const every = n.everySecs < 60 ? n.everySecs + ' s' : Math.round(n.everySecs / 60) + ' min';
  const soon = n.due === '0' ? '' : '$' + (Number(n.due) / 1e6).toFixed(6) + (n.first ? ' goes out in the next round, within ' + every + ', as this node’s first payout.' : ' is due and goes out in the next round, within ' + every + '.');
  if (n.below === '0') return soon;
  const rest = '$' + (Number(n.below) / 1e6).toFixed(6) + (soon ? ' more' : ' is') + ' waiting in ' + n.belowChannels + ' channel' + (n.belowChannels === 1 ? '' : 's') + '. '
    + (n.belowChannels === 1 ? 'It pays' : 'Each pays') + ' out once it reaches $' + (Number(n.floor) / 1e6).toFixed(6) + ' or its router closes it; this node checks every ' + every + '.';
  return soon ? soon + ' ' + rest : rest;
}

/** The console's payout rows: the latest payouts, newest first, each with its transaction (whole in the title), then
 * the last 24 hours. Its source goes into the page, so it uses nothing from outside itself and names no local function
 * (tsx would wrap one in a helper the browser does not have); what it prints is digits
 * and base58, which readPayouts checks. `checked`, which the page fills from /orrery/payouts/check, says beside each
 * payout what the chain says reached the wallet; only its state is compared and only numbers from it are printed.
 * The transaction is a button that copies the whole signature, to look it up on any Solana explorer: the page itself
 * names no other computer, and a link would hand the explorer this page's address, key and all. */
export function payoutRows(p: { day: { units: string; count: number }; recent: { at: number; units: string; channels: number; tx: string }[]; checked?: Record<string, { state: string; units: string | null }> } | null): string {
  if (!p || !p.recent.length) return '<tr class=empty><td colspan=5>None recorded here yet. Each payout this node sends to your wallet is listed here, with its transaction.</td></tr>';
  return p.recent.map((r) => '<tr><td>' + new Date(r.at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC</td><td class=go>$' + (Number(r.units) / 1e6).toFixed(6) + '</td><td>' + r.channels + '</td><td title="' + r.tx + '"><button class=tx type=button data-tx="' + r.tx + '" aria-label="Copy the whole transaction">' + r.tx.slice(0, 12) + '…</button></td><td>'
    + (!p.checked || !p.checked[r.tx] ? '' : p.checked[r.tx].state === 'missing' ? '<span class=stop>no record on chain</span>' : p.checked[r.tx].state === 'failed' ? '<span class=stop>failed on chain</span>'
      : p.checked[r.tx].state !== 'landed' ? '' : (p.checked[r.tx].units === r.units ? '<span class=go>arrived $' : '<span class=stop>arrived $') + (Number(p.checked[r.tx].units) / 1e6).toFixed(6) + '</span>') + '</td></tr>').join('')
    + '<tr><td>last 24 h</td><td class=go>$' + (Number(p.day.units) / 1e6).toFixed(6) + '</td><td colspan=3>' + p.day.count + ' payout' + (p.day.count === 1 ? '' : 's') + '</td></tr>';
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

/** What the wallet's USDC account held right after the payout, from the same record; null when it is not in it. */
export function balanceAfter(tx: PayoutTx, wallet: string, mint: string): bigint | null {
  const after = (tx?.meta?.postTokenBalances ?? []).find((b) => b.owner === wallet && b.mint === mint);
  return after ? BigInt(after.uiTokenAmount.amount) : null;
}

/** The log line once a payout's transaction is read back from the chain:
 *   $0.050123 arrived in your wallet: the chain's record of tx 5GhKq2abcdef… shows it in your USDC account */
export function arrivalNote(p: Payout, c: Landed, after: bigint | null = null): string {
  const tx = `tx ${p.tx.slice(0, 12)}…`;
  if (c.state === 'failed') return `${tx} failed on chain: nothing of the $${usd(BigInt(p.units))} reached your wallet. See orrery provider payouts`;
  if (c.state === 'missing') return `the RPC has no record of ${tx} yet`;
  if (c.units === BigInt(p.units)) return `$${usd(c.units)} arrived in your wallet: the chain's record of ${tx} shows it in your USDC account${after === null ? '' : `, which then held $${usd(after)}`}`;
  return `${tx} put $${usd(c.units)} in your wallet, not the $${usd(BigInt(p.units))} this node redeemed. See orrery provider payouts`;
}

/** What the node posts to its `notify` webhook once a payout's transaction is read back from the chain: the log's own
 * line, under `text` (the field Slack's incoming webhooks read) and `content` (the field Discord's read), and the
 * figures for a script. The webhook gets nothing a payout's transaction does not already show on chain. */
export function payoutNotice(node: string, p: Payout, c: Landed, after: bigint | null = null): { text: string; content: string; payout: Record<string, string | null> } {
  const line = `${node}: ${arrivalNote(p, c, after)}`;
  return {
    text: line,
    content: line,
    payout: { node, at: new Date(p.at).toISOString(), tx: p.tx, state: c.state, redeemed: usd(BigInt(p.units)), arrived: c.state === 'landed' ? usd(c.units) : null, walletAfter: after === null ? null : usd(after) },
  };
}

/** The webhook a payout notice goes to: `notify.url`, or the environment variable `notify.urlEnv` names (a webhook
 * address is a secret, as good as a password to post in that channel). Null when there is none. */
export function notifyUrl(n: { url?: string; urlEnv?: string } | undefined, env: Record<string, string | undefined> = process.env): string | null {
  if (!n) return null;
  const raw = n.url ?? (n.urlEnv ? env[n.urlEnv] : undefined);
  if (!raw) throw new Error(n.urlEnv ? `notify: environment variable ${n.urlEnv} is not set` : 'notify: give "url" or "urlEnv"');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('notify: the webhook address is not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('notify: the webhook address must start with https:// or http://');
  return u.toString();
}

/** Posts a notice to the webhook; the HTTP status it answered, or null when it could not be reached in ten seconds. */
export async function postNotice(url: string, body: unknown, f: typeof fetch = fetch): Promise<number | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    await r.text().catch(() => '');
    return r.status;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** The status's payouts, with each listed one the node has seen arrive as kept marked for the console's "on chain"
 * column. */
export function withChecked(s: PayoutSummary | null, known: Map<string, Landed>): (PayoutSummary & { checked: Record<string, { state: 'landed'; units: string }> }) | null {
  if (!s) return null;
  const checked: Record<string, { state: 'landed'; units: string }> = {};
  for (const r of s.recent) {
    const c = known.get(r.tx);
    if (c?.state === 'landed') checked[r.tx] = { state: 'landed', units: c.units.toString() };
  }
  return { ...s, checked };
}

type TxReader = { getTransaction: (sig: string, opts: { commitment: 'confirmed'; maxSupportedTransactionVersion: 0 }) => Promise<unknown> };

/** Each payout beside what the chain's record of its transaction says reached the wallet, five lookups at a time; null
 * where the RPC did not answer. A payout found to have arrived as kept goes into `known` and is not looked up again. */
export async function checkPayouts(conn: TxReader, list: Payout[], wallet: string, mint: string, known?: Map<string, Landed>): Promise<{ p: Payout; chain: Landed | null; after: bigint | null }[]> {
  const rows: { p: Payout; chain: Landed | null; after: bigint | null }[] = [];
  for (let i = 0; i < list.length; i += 5) {
    const part = list.slice(i, i + 5);
    const looked = await Promise.all(part.map((p): Promise<{ chain: Landed | null; after: bigint | null }> => {
      const seen = known?.get(p.tx);
      if (seen) return Promise.resolve({ chain: seen, after: null });
      return conn.getTransaction(p.tx, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
        .then((tx) => ({ chain: landedUnits(tx as PayoutTx, wallet, mint), after: balanceAfter(tx as PayoutTx, wallet, mint) }))
        .catch(() => ({ chain: null, after: null }));
    }));
    part.forEach((p, j) => {
      const { chain: c, after } = looked[j];
      if (known && c?.state === 'landed' && c.units === BigInt(p.units)) known.set(p.tx, c);
      rows.push({ p, chain: c, after });
    });
  }
  return rows;
}

/** `provider payouts --csv`: the same rows for a spreadsheet, with the whole transaction and what the chain said:
 *   time_utc,paid_out_usdc,channels,tx,on_chain,arrived_usdc,wallet_after_usdc */
export function payoutsCsv(rows: { p: Payout; chain: Landed | null; after?: bigint | null }[]): string {
  return ['time_utc,paid_out_usdc,channels,tx,on_chain,arrived_usdc,wallet_after_usdc', ...rows.map(({ p, chain, after }) => [
    new Date(p.at).toISOString().slice(0, 19).replace('T', ' '), usd(BigInt(p.units)), p.channels, p.tx,
    chain ? chain.state : 'unchecked', chain?.state === 'landed' ? usd(chain.units) : '', chain?.state === 'landed' && after != null ? usd(after) : '',
  ].join(','))].join('\n');
}

/** `provider payouts`: each payout this node kept, newest first, next to what the chain says reached the wallet,
 *   2026-11-18 14:05:11 UTC  $0.050123  2 channels  tx 5GhKq2abcdef…  arrived $0.050123, wallet then $1.250123
 * then a line that adds them up and says whether every one arrived as kept. */
export function payoutCheckLines(name: string, rows: { p: Payout; chain: Landed | null; after?: bigint | null }[], total: number): string[] {
  if (!rows.length) return [`"${name}" has kept no payout yet. Each payout it sends to your wallet is kept in payouts.jsonl in its folder, with its transaction.`];
  const said = (c: Landed | null, p: Payout) => {
    if (!c) return 'not checked';
    if (c.state === 'missing') return 'the RPC has no record of it';
    if (c.state === 'failed') return 'failed on chain';
    return c.units === BigInt(p.units) ? `arrived $${usd(c.units)}` : `arrived $${usd(c.units)}, kept here as $${usd(BigInt(p.units))}`;
  };
  const lines = rows.map(({ p, chain, after }) => `  ${new Date(p.at).toISOString().slice(0, 19).replace('T', ' ')} UTC  $${usd(BigInt(p.units))}  ${p.channels} channel${p.channels === 1 ? ' ' : 's'}  tx ${p.tx.slice(0, 12)}…  ${said(chain, p)}${chain?.state === 'landed' && after != null ? `, wallet then $${usd(after)}` : ''}`);
  const head = `"${name}", the last ${rows.length} of ${total} payout${total === 1 ? '' : 's'} kept here, each checked against the chain`;
  const checked = rows.filter((r) => r.chain);
  if (!checked.length) return [head, ...lines, 'the RPC did not answer; nothing was checked'];
  const asKept = checked.filter((r) => r.chain!.state === 'landed' && (r.chain as { units: bigint }).units === BigInt(r.p.units));
  const sum = asKept.reduce((n, r) => n + BigInt(r.p.units), 0n);
  const rest = checked.length - asKept.length;
  const unchecked = rows.length - checked.length;
  return [head, ...lines, `${asKept.length} of ${checked.length} arrived in your wallet as kept here, $${usd(sum)} in all${rest ? `; ${rest} did not (see above)` : ''}${unchecked ? `; ${unchecked} not checked, the RPC did not answer` : ''}`];
}
