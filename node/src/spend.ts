// What this router paid, read from its own log of answers (one JSON line each, appended as they are signed for).
// `orrery spend` sums it by model or by provider for any window, so an agent's bill comes from your own disk.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { TICKER } from './brand.ts';
import { usd } from './pricing.ts';

/** `enclave` is kept for a sealed answer: the hardware the router verified before it encrypted the prompt, the image
 * that machine booted, and the verdict the router reached. `task` is the job an agent named for the request. */
export type Enclave = { kind: string; image: string; verdict: string };
export type LoggedTrip = { at: number; model: string; provider: string; providerName: string; inputTokens: number; outputTokens: number; cost: string; cacheKept?: boolean; fellThrough?: number; resumed?: boolean; sealed?: boolean; enclave?: Enclave; task?: string; inside?: boolean; ttftMs?: number; billed?: string; listed?: string; off?: number; saved?: string; agent?: string; kind?: string };

/** The log rolls over at this size: the current file becomes <path>.1 (replacing the previous one) and a new one starts. */
export const ROLL_BYTES = 10 * 1024 * 1024;

export function appendTrip(path: string, t: LoggedTrip, rollBytes = ROLL_BYTES) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= rollBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: t.at, model: t.model, provider: t.provider, providerName: t.providerName, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost, ...(t.cacheKept ? { cacheKept: true } : {}), ...(t.fellThrough ? { fellThrough: t.fellThrough } : {}), ...(t.resumed ? { resumed: true } : {}), ...(t.sealed ? { sealed: true } : {}), ...(t.sealed && t.enclave ? { enclave: t.enclave } : {}), ...(t.task ? { task: t.task } : {}), ...(t.inside ? { inside: true } : {}), ...(typeof t.ttftMs === 'number' ? { ttftMs: t.ttftMs } : {}), ...(typeof t.billed === 'string' ? { billed: t.billed } : {}), ...(typeof t.listed === 'string' ? { listed: t.listed } : {}), ...(t.off ? { off: t.off } : {}), ...(typeof t.saved === 'string' ? { saved: t.saved } : {}), ...(t.agent ? { agent: t.agent } : {}), ...(t.kind ? { kind: t.kind } : {}) })}\n`);
  } catch {
    // The log is a convenience; an answer is never held back because it could not be written.
  }
}

/** A request no node answered: every node asked failed, and the client was told so. Nothing was signed for it. */
export type Unanswered = { at: number; model: string; asked: number };

export function appendUnanswered(path: string, u: Unanswered, rollBytes = ROLL_BYTES / 10) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= rollBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: u.at, model: u.model, asked: u.asked })}\n`);
  } catch {
    // a convenience, like the log of answers
  }
}

export function readUnanswered(path: string): Unanswered[] {
  const text = [`${path}.1`, path].filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8')).join('\n');
  return text.split('\n').flatMap((line) => {
    try {
      const u = JSON.parse(line) as Unanswered;
      return typeof u.at === 'number' && typeof u.asked === 'number' ? [u] : [];
    } catch {
      return [];
    }
  });
}

export function unansweredIn(list: Unanswered[], sinceMs: number, now = Date.now()): { requests: number; nodes: number } {
  const recent = list.filter((u) => now - u.at <= sinceMs);
  return { requests: recent.length, nodes: recent.reduce((a, u) => a + u.asked, 0) };
}

/** The line under a spend total for requests no node answered, or nothing. A node is paid by a voucher the router
 * signs after an answer, so a request with no answer cost nothing. */
export function unansweredNote(u: { requests: number; nodes: number }): string {
  if (!u.requests) return '';
  const one = u.requests === 1;
  const who = one && u.nodes <= 1 ? 'the node asked' : `any node asked${u.nodes > u.requests ? ` (${u.nodes} nodes asked in all)` : ''}`;
  return `${u.requests} request${one ? '' : 's'} got no answer from ${who}; nothing was signed or paid for ${one ? 'it' : 'them'}.`;
}

export function readTrips(path: string): LoggedTrip[] {
  const out: LoggedTrip[] = [];
  const text = [`${path}.1`, path].filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8')).join('\n');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LoggedTrip);
    } catch {
      continue;
    }
  }
  return out;
}

/** "24h", "7d", "90m" as milliseconds; anything else is everything. */
export function windowMs(s: string | undefined): number {
  const m = /^(\d+)\s*([mhd])$/.exec((s ?? '').trim());
  if (!m) return Infinity;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

const units = (usd: string) => {
  const [w, f = ''] = usd.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};

export type SpendRow = { key: string; answers: number; inputTokens: number; outputTokens: number; units: bigint; cacheKept: number };

export type SpendBy = 'model' | 'provider' | 'task' | 'day' | 'agent' | 'kind';

/** The kind of work a listed model does: what its listing says, else embeddings for a model with no output price
 * (provider init lists embedding models that way), else chat. A model no longer listed counts as chat. */
export const workKind = (m: { kind?: string; price: { output: number } } | undefined): string => m?.kind ?? (m?.price.output === 0 ? 'embeddings' : 'chat');

/** Rows by model folded into rows by the kind of work, by the node's own listing: what chat, embeddings and
 * reranking each billed. Most billed first. */
export function rowsByKind(rows: SpendRow[], models: { id: string; kind?: string; price: { output: number } }[]): SpendRow[] {
  const out = new Map<string, SpendRow>();
  for (const r of rows) {
    const key = workKind(models.find((m) => m.id === r.key));
    const k = out.get(key) ?? { key, answers: 0, inputTokens: 0, outputTokens: 0, units: 0n, cacheKept: 0 };
    k.answers += r.answers;
    k.inputTokens += r.inputTokens;
    k.outputTokens += r.outputTokens;
    k.units += r.units;
    k.cacheKept += r.cacheKept;
    out.set(key, k);
  }
  return [...out.values()].sort((a, b) => (a.units === b.units ? a.key.localeCompare(b.key) : a.units > b.units ? -1 : 1));
}

/** Totals by model, provider, task or agent, most expensive first, plus the grand total. Answers outside any task (or
 * agent) are grouped as "(no task)" ("(no agent)"). By day, one row a UTC day, newest first: the router's own books of
 * what it paid. */
export function summarize(trips: LoggedTrip[], by: SpendBy, sinceMs: number, now = Date.now()) {
  const rows = new Map<string, SpendRow>();
  const total: SpendRow = { key: 'total', answers: 0, inputTokens: 0, outputTokens: 0, units: 0n, cacheKept: 0 };
  for (const t of trips) {
    if (now - t.at > sinceMs) continue;
    const key = by === 'model' ? t.model : by === 'task' ? (t.task ?? '(no task)') : by === 'agent' ? (t.agent ?? '(no agent)') : by === 'kind' ? (t.kind ?? 'chat') : by === 'day' ? new Date(t.at).toISOString().slice(0, 10) : t.providerName;
    const r = rows.get(key) ?? { key, answers: 0, inputTokens: 0, outputTokens: 0, units: 0n, cacheKept: 0 };
    for (const x of [r, total]) {
      x.answers += 1;
      x.inputTokens += t.inputTokens;
      x.outputTokens += t.outputTokens;
      x.units += units(t.cost);
      if (t.cacheKept) x.cacheKept += 1;
    }
    rows.set(key, r);
  }
  const order = by === 'day' ? (a: SpendRow, b: SpendRow) => (a.key < b.key ? 1 : -1) : (a: SpendRow, b: SpendRow) => (b.units > a.units ? 1 : b.units < a.units ? -1 : b.answers - a.answers);
  return { rows: [...rows.values()].sort(order), total };
}

/** `orrery spend --csv`: the same rows for a spreadsheet or an expense report, amounts in USDC, no total row. A name
 * with a comma or a quote in it (a task's, say) is quoted the CSV way. */
export function spendCsv(rows: SpendRow[], by: SpendBy): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [`${by === 'day' ? 'day_utc' : by},answers,input_tokens,output_tokens,paid_usdc`, ...rows.map((r) => `${cell(r.key)},${r.answers},${r.inputTokens},${r.outputTokens},${usd(r.units)}`)].join('\n');
}

/** What the router paid this UTC month so far, from its log of answers: the line under its books by day. `saved` is what
 * holding the network token took off those answers (the `saved` the log keeps on each one at a holder price). */
export function spentThisMonth(trips: LoggedTrip[], now = Date.now()): { month: string; answers: number; units: bigint; saved: bigint } {
  const month = new Date(now).toISOString().slice(0, 7);
  let answers = 0, paid = 0n, saved = 0n;
  for (const t of trips) {
    if (t.at > now || new Date(t.at).toISOString().slice(0, 7) !== month) continue;
    answers += 1;
    paid += units(t.cost);
    if (typeof t.saved === 'string') saved += units(t.saved);
  }
  return { month, answers, units: paid, saved };
}

/** "November so far (UTC): 857 answers, $0.439719 paid" */
export function spentMonthLine(m: { month: string; answers: number; units: bigint }): string {
  const name = new Date(`${m.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${name} so far (UTC): ${m.answers.toLocaleString('en-US')} answer${m.answers === 1 ? '' : 's'}, $${usd(m.units)} paid`;
}

/** What holding the network token took off the answers in the window. On each answer a node priced at its holder price,
 * the router logs the difference from that node's listed prices for the same tokens (`saved`) and the discount (`off`). */
export function heldSaved(trips: LoggedTrip[], sinceMs: number, now = Date.now()): { answers: number; units: bigint; offs: number[] } {
  let answers = 0, saved = 0n;
  const offs = new Set<number>();
  for (const t of trips) {
    if (now - t.at > sinceMs || typeof t.saved !== 'string') continue;
    answers += 1;
    saved += units(t.saved);
    if (t.off) offs.add(t.off);
  }
  return { answers, units: saved, offs: [...offs].sort((a, b) => a - b) };
}

/** The line under a spend total, or nothing when no answer in the window had a holder price:
 *   Holding $OREY took $0.000412 off 12 of these answers: the nodes that served them charge holders 35% less. */
export function heldSavedLine(h: { answers: number; units: bigint; offs: number[] }): string {
  if (!h.answers) return '';
  const pct = (bp: number) => `${bp / 100}%`;
  const less = h.offs.length > 1 ? `${pct(h.offs[0])} to ${pct(h.offs[h.offs.length - 1])}` : h.offs.length ? pct(h.offs[0]) : '';
  const which = h.answers === 1 ? 'one of these answers' : `${h.answers.toLocaleString('en-US')} of these answers`;
  const who = h.answers === 1 ? 'the node that served it charges' : 'the nodes that served them charge';
  return `Holding $${TICKER} took $${usd(h.units)} off ${which}${less ? `: ${who} holders ${less} less` : ''}.`;
}

/** The same from the node's side, under its earnings: of `answers` served in the window, how many went at its holder
 * price and what that came to below its list prices. Nothing when none did.
 *   holder prices: 12 of 59 answers went to $OREY holders at 35% off, $0.000412 under your list prices */
export function heldGivenLine(h: { answers: number; units: bigint; offs: number[] }, answers: number): string {
  if (!h.answers) return '';
  const pct = (bp: number) => `${bp / 100}%`;
  const at = h.offs.length > 1 ? ` at ${pct(h.offs[0])} to ${pct(h.offs[h.offs.length - 1])} off` : h.offs.length ? ` at ${pct(h.offs[0])} off` : '';
  return `holder prices: ${h.answers.toLocaleString('en-US')} of ${answers.toLocaleString('en-US')} answer${answers === 1 ? '' : 's'} went to $${TICKER} holders${at}, $${usd(h.units)} under your list prices`;
}

/** Of the answers in the window: how many came from the next node after another did not answer, how many nodes were
 * passed over in all, and how many were finished by another node after the first stopped mid-answer (counted apart:
 * that first node did start). The router logs both on each answer (`fellThrough`, `resumed`). */
export function skipped(trips: LoggedTrip[], sinceMs: number, now = Date.now()): { answers: number; nodes: number; resumed: number } {
  const recent = trips.filter((t) => now - t.at <= sinceMs);
  const after = recent.filter((t) => (t.fellThrough ?? 0) > 0 && !t.resumed);
  return { answers: after.length, nodes: after.reduce((a, t) => a + (t.fellThrough ?? 0), 0), resumed: recent.filter((t) => t.resumed).length };
}

/** The line under a spend total for those answers, or nothing when there were none. A node is paid by a voucher the
 * router signs after an answer; one that does not answer gets no voucher. */
export function skipNote(s: { answers: number; nodes: number; resumed?: number }): string {
  const resumed = s.resumed ?? 0;
  const noAnswer = s.answers ? `${s.answers} of these answers came from the next node after another did not answer${s.nodes > s.answers ? ` (${s.nodes} skipped in all)` : ''}` : '';
  const finished = `${resumed === 1 ? 'was' : 'were'} finished by another node after the first stopped mid-answer`;
  if (noAnswer && resumed) return `${noAnswer}; ${resumed} ${finished}. A node that does not answer or does not finish is signed nothing.`;
  if (noAnswer) return `${noAnswer}. A node that does not answer is signed nothing.`;
  if (resumed) return `${resumed} of these answers ${finished}. A node that does not finish an answer is signed nothing for it.`;
  return '';
}

/** Every sealed answer in the window, newest first: which machine handled it and what the router had verified. */
/** Of the answers in the window, how many were paid inside the seal (the channel and voucher in the sealed body) rather
 * than in headers a node's host can read. A node logs `inside` on each answer it served that way. */
export type Speed = { provider: string; name: string; answers: number; medianTtftMs: number };

/** How fast each node started answering, by this router's own clock: the median time to the first token over the
 * answers in the window that have one on record. Nobody reports it; it is read from the router's log. Nodes with
 * the most answers come first. */
export function speeds(trips: LoggedTrip[], sinceMs: number, now = Date.now()): Speed[] {
  const by = new Map<string, { name: string; ms: number[] }>();
  for (const t of trips) {
    if (now - t.at > sinceMs || typeof t.ttftMs !== 'number' || !(t.ttftMs >= 0)) continue;
    const e = by.get(t.provider) ?? { name: t.providerName, ms: [] };
    e.name = t.providerName;
    e.ms.push(t.ttftMs);
    by.set(t.provider, e);
  }
  const median = (ms: number[]) => { const a = [...ms].sort((x, y) => x - y), h = a.length >> 1; return a.length % 2 ? a[h] : Math.round((a[h - 1] + a[h]) / 2); };
  return [...by.entries()].map(([provider, e]) => ({ provider, name: e.name, answers: e.ms.length, medianTtftMs: median(e.ms) })).sort((a, b) => b.answers - a.answers);
}

/** "started answering in 0.9 s (median of 42 answers in the last 24 h)". */
export function speedText(s: { answers: number; medianTtftMs: number }, window = '24 h'): string {
  const took = s.medianTtftMs < 1000 ? `${Math.round(s.medianTtftMs)} ms` : `${(s.medianTtftMs / 1000).toFixed(1)} s`;
  return `started answering in ${took} (${s.answers === 1 ? '1 answer' : `median of ${s.answers.toLocaleString('en-US')} answers`} in the last ${window})`;
}

export type Bills = { provider: string; name: string; checked: number; over: number };

/** What each node billed this router, against what the prices it listed on chain come to for the same tokens, over the
 * answers in the window that have both on record. `over` counts the bills above the listed prices; the router paid no
 * more than those prices either way. Nodes with the most answers come first. */
export function bills(trips: LoggedTrip[], sinceMs: number, now = Date.now()): Bills[] {
  const by = new Map<string, Bills>();
  for (const t of trips) {
    if (now - t.at > sinceMs || typeof t.billed !== 'string' || typeof t.listed !== 'string') continue;
    const b = by.get(t.provider) ?? { provider: t.provider, name: t.providerName, checked: 0, over: 0 };
    b.name = t.providerName;
    b.checked += 1;
    if (units(t.billed) > units(t.listed)) b.over += 1;
    by.set(t.provider, b);
  }
  return [...by.values()].sort((a, b) => b.checked - a.checked);
}

export function billsText(b: { checked: number; over: number }, window = '24 h'): string {
  const n = (k: number) => k.toLocaleString('en-US');
  if (b.over === 0) return b.checked === 1 ? `its bill was within its listed prices (1 answer in the last ${window})` : `every bill was within its listed prices (${n(b.checked)} answers in the last ${window})`;
  return `billed above its listed prices in ${n(b.over)} of ${n(b.checked)} answers in the last ${window}; this router paid no more than those prices`;
}

/** The answers in the window that went to an enclave this router verified (:private, or a router run --private-only),
 * and what they cost: the part of the bill whose prompts not even the node's operator could read. */
export function privateSpend(trips: LoggedTrip[], sinceMs: number, now = Date.now()): { answers: number; units: bigint } {
  const recent = trips.filter((t) => t.sealed && now - t.at <= sinceMs);
  return { answers: recent.length, units: recent.reduce((a, t) => a + units(t.cost), 0n) };
}

/** The line under a spend total, or nothing when no answer in the window went to an enclave:
 *   3 of these 41 answers went to an enclave this router verified, $0.000096 of the total (orrery sealed lists them). */
export function privateSpendLine(p: { answers: number; units: bigint }, total: { answers: number }): string {
  if (!p.answers) return '';
  return `${p.answers} of these ${total.answers} answer${total.answers === 1 ? '' : 's'} went to an enclave this router verified, $${usd(p.units)} of the total (orrery sealed lists them).`;
}

export function paidInside(trips: LoggedTrip[], sinceMs: number, now = Date.now()): { answers: number; inside: number } {
  const recent = trips.filter((t) => now - t.at <= sinceMs);
  return { answers: recent.length, inside: recent.filter((t) => t.inside).length };
}

export function sealedTrips(trips: LoggedTrip[], sinceMs: number, now = Date.now()): LoggedTrip[] {
  return trips.filter((t) => t.sealed && now - t.at <= sinceMs).sort((a, b) => b.at - a.at);
}
