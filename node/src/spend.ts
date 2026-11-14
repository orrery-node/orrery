// What this router paid, read from its own log of answers (one JSON line each, appended as they are signed for).
// `orrery spend` sums it by model or by provider for any window, so an agent's bill comes from your own disk.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** `enclave` is kept for a sealed answer: the hardware the router verified before it encrypted the prompt, the image
 * that machine booted, and the verdict the router reached. `task` is the job an agent named for the request. */
export type Enclave = { kind: string; image: string; verdict: string };
export type LoggedTrip = { at: number; model: string; provider: string; providerName: string; inputTokens: number; outputTokens: number; cost: string; cacheKept?: boolean; fellThrough?: number; resumed?: boolean; sealed?: boolean; enclave?: Enclave; task?: string; inside?: boolean };

/** The log rolls over at this size: the current file becomes <path>.1 (replacing the previous one) and a new one starts. */
export const ROLL_BYTES = 10 * 1024 * 1024;

export function appendTrip(path: string, t: LoggedTrip, rollBytes = ROLL_BYTES) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= rollBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: t.at, model: t.model, provider: t.provider, providerName: t.providerName, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost, ...(t.cacheKept ? { cacheKept: true } : {}), ...(t.fellThrough ? { fellThrough: t.fellThrough } : {}), ...(t.resumed ? { resumed: true } : {}), ...(t.sealed ? { sealed: true } : {}), ...(t.sealed && t.enclave ? { enclave: t.enclave } : {}), ...(t.task ? { task: t.task } : {}), ...(t.inside ? { inside: true } : {}) })}\n`);
  } catch {
    // The log is a convenience; an answer is never held back because it could not be written.
  }
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

/** Totals by model, provider or task, most expensive first, plus the grand total. Answers outside any task are grouped as "(no task)". */
export function summarize(trips: LoggedTrip[], by: 'model' | 'provider' | 'task', sinceMs: number, now = Date.now()) {
  const rows = new Map<string, SpendRow>();
  const total: SpendRow = { key: 'total', answers: 0, inputTokens: 0, outputTokens: 0, units: 0n, cacheKept: 0 };
  for (const t of trips) {
    if (now - t.at > sinceMs) continue;
    const key = by === 'model' ? t.model : by === 'task' ? (t.task ?? '(no task)') : t.providerName;
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
  return { rows: [...rows.values()].sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : b.answers - a.answers)), total };
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
export function paidInside(trips: LoggedTrip[], sinceMs: number, now = Date.now()): { answers: number; inside: number } {
  const recent = trips.filter((t) => now - t.at <= sinceMs);
  return { answers: recent.length, inside: recent.filter((t) => t.inside).length };
}

export function sealedTrips(trips: LoggedTrip[], sinceMs: number, now = Date.now()): LoggedTrip[] {
  return trips.filter((t) => t.sealed && now - t.at <= sinceMs).sort((a, b) => b.at - a.at);
}
