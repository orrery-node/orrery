// A router's own record of a node: how many health checks it made since it started watching, and how many found the
// node answering with its model server up. Nobody vouches for it; each router keeps and shows its own.
export type Watched = { checks: number; up: number; since: number };

const span = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 2 * 86_400_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`);

/** "up in 118 of 120 checks this router made over 1 h"; empty when there is no record yet. */
export function watchedText(w: Watched | null | undefined, now = Date.now()): string {
  if (!w || w.checks < 1) return '';
  return `up in ${w.up.toLocaleString('en-US')} of ${w.checks.toLocaleString('en-US')} check${w.checks === 1 ? '' : 's'} this router made over ${span(now - w.since)}`;
}
