// A router's own record of a node: how many health checks it made since it started watching, and how many found the
// node answering with its model server up. Nobody vouches for it; each router keeps and shows its own.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { speedText } from '../spend.ts';

/** `sent`/`answered`: the requests this router sent the node and how many it answered, counted from `askedSince`. */
export type Watched = { checks: number; up: number; since: number; sent?: number; answered?: number; askedSince?: number };

const isRecord = (w: unknown): w is Watched => {
  const r = w as Watched | null;
  return !!r && typeof r === 'object' && [r.checks, r.up, r.since].every((n) => Number.isSafeInteger(n) && n >= 0) && r.up <= r.checks;
};

/** The request counts of a record, when they can be true; a record with counts that cannot be keeps the rest. */
const asked = (w: Watched): Pick<Watched, 'sent' | 'answered' | 'askedSince'> => {
  const ok = [w.sent, w.answered, w.askedSince].every((n) => Number.isSafeInteger(n) && (n as number) >= 0) && (w.answered as number) <= (w.sent as number);
  return ok ? { sent: w.sent, answered: w.answered, askedSince: w.askedSince } : {};
};

/** The record a router left in its home folder; empty from a missing or unreadable file, which only starts it over. */
export function loadWatched(path: string | undefined): Map<string, Watched> {
  try {
    if (!path || !existsSync(path)) return new Map();
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return new Map(Object.entries(j).filter((e): e is [string, Watched] => isRecord(e[1])).map(([k, w]) => [k, { checks: w.checks, up: w.up, since: w.since, ...asked(w) }]));
  } catch {
    return new Map();
  }
}

/** Writes the record whole, through a temporary file, so a crash mid-write leaves the old one. A record that cannot be
 * written is not worth stopping a router for. */
export function saveWatched(path: string, m: Map<string, Watched>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries(m)));
    renameSync(`${path}.tmp`, path);
  } catch {
    // kept in memory only
  }
}

export const span = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 2 * 86_400_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`);

/** "up in 118 of 120 checks this router made over 1 h"; empty when there is no record yet. */
export function watchedText(w: Watched | null | undefined, now = Date.now()): string {
  if (!w || w.checks < 1) return '';
  return `up in ${w.up.toLocaleString('en-US')} of ${w.checks.toLocaleString('en-US')} check${w.checks === 1 ? '' : 's'} this router made over ${span(now - w.since)}`;
}

/** "answered 41 of 43 requests this router sent it since it started", from the router's own count of what the node
 * did with its requests (kept in memory, so it starts over with the router). Empty before the first request. A
 * request the node answered against its own listing was still answered: only unanswered ones are left out. */
export function answeredText(o: { ok: number; fail: number; broke?: number } | Watched | null | undefined, now = Date.now()): string {
  if (!o) return '';
  // The record kept on disk says over how long; a router that only has its counts in memory says since it started.
  const kept = 'checks' in o;
  if (kept && (o.sent === undefined || o.answered === undefined || o.askedSince === undefined)) return '';
  const answered = kept ? o.answered! : o.ok, sent = kept ? o.sent! : o.ok + Math.max(0, o.fail - (o.broke ?? 0));
  if (sent < 1) return '';
  const n = (x: number) => x.toLocaleString('en-US');
  const of = answered === sent ? (sent === 1 ? 'the 1 request' : `all ${n(sent)} requests`) : `${n(answered)} of ${n(sent)} requests`;
  return `answered ${of} this router sent it ${kept ? `over ${span(now - o.askedSince!)}` : 'since it started'}`;
}

/** The whole record of a node as lines a person reads, for the console and for an agent: how often it was up when
 * this router checked, what it did with the requests it was sent (the record on disk, else the counts since start),
 * and how fast it started answering. Empty before there is anything to say. */
export function recordLines(o: { watched: Watched | null | undefined; observed: { ok: number; fail: number; broke?: number } | null | undefined; speed: { answers: number; medianTtftMs: number } | null | undefined }, now = Date.now()): string[] {
  return [watchedText(o.watched, now), answeredText(o.watched, now) || answeredText(o.observed, now), o.speed && o.speed.answers > 0 ? speedText(o.speed) : ''].filter((l) => l.length > 0);
}
