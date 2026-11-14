// A router's own record of a node: how many health checks it made since it started watching, and how many found the
// node answering with its model server up. Nobody vouches for it; each router keeps and shows its own.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type Watched = { checks: number; up: number; since: number };

const isRecord = (w: unknown): w is Watched => {
  const r = w as Watched | null;
  return !!r && typeof r === 'object' && [r.checks, r.up, r.since].every((n) => Number.isSafeInteger(n) && n >= 0) && r.up <= r.checks;
};

/** The record a router left in its home folder; empty from a missing or unreadable file, which only starts it over. */
export function loadWatched(path: string | undefined): Map<string, Watched> {
  try {
    if (!path || !existsSync(path)) return new Map();
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return new Map(Object.entries(j).filter((e): e is [string, Watched] => isRecord(e[1])).map(([k, w]) => [k, { checks: w.checks, up: w.up, since: w.since }]));
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

const span = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 2 * 86_400_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`);

/** "up in 118 of 120 checks this router made over 1 h"; empty when there is no record yet. */
export function watchedText(w: Watched | null | undefined, now = Date.now()): string {
  if (!w || w.checks < 1) return '';
  return `up in ${w.up.toLocaleString('en-US')} of ${w.checks.toLocaleString('en-US')} check${w.checks === 1 ? '' : 's'} this router made over ${span(now - w.since)}`;
}
