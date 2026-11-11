// What this router paid, read from its own log of answers (one JSON line each, appended as they are signed for).
// `orrery spend` sums it by model or by provider for any window, so an agent's bill comes from your own disk.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** `enclave` is kept for a sealed answer: the hardware the router verified before it encrypted the prompt, the image
 * that machine booted, and the verdict the router reached. `task` is the job an agent named for the request. */
export type Enclave = { kind: string; image: string; verdict: string };
export type LoggedTrip = { at: number; model: string; provider: string; providerName: string; inputTokens: number; outputTokens: number; cost: string; cacheKept?: boolean; fellThrough?: number; sealed?: boolean; enclave?: Enclave; task?: string };

/** The log rolls over at this size: the current file becomes <path>.1 (replacing the previous one) and a new one starts. */
export const ROLL_BYTES = 10 * 1024 * 1024;

export function appendTrip(path: string, t: LoggedTrip, rollBytes = ROLL_BYTES) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= rollBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: t.at, model: t.model, provider: t.provider, providerName: t.providerName, inputTokens: t.inputTokens, outputTokens: t.outputTokens, cost: t.cost, ...(t.cacheKept ? { cacheKept: true } : {}), ...(t.fellThrough ? { fellThrough: t.fellThrough } : {}), ...(t.sealed ? { sealed: true } : {}), ...(t.sealed && t.enclave ? { enclave: t.enclave } : {}), ...(t.task ? { task: t.task } : {}) })}\n`);
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

/** Every sealed answer in the window, newest first: which machine handled it and what the router had verified. */
export function sealedTrips(trips: LoggedTrip[], sinceMs: number, now = Date.now()): LoggedTrip[] {
  return trips.filter((t) => t.sealed && now - t.at <= sinceMs).sort((a, b) => b.at - a.at);
}
