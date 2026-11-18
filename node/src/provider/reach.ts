// Whether anything outside this computer is reaching the node. A router that knows a node asks its /health every 30
// seconds, so these checks are the first sign a new operator can get that the public address works, before any answer
// comes. Only the count and the time are kept, in memory: never who asked.

const HOUR = 3_600_000;
const MOST = 20_000;

export type ReachNow = { lastHour: number; lastAt: number | null; upMs: number };

export class Reach {
  private at: number[] = [];
  private readonly startedAt: number;

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  note(now = Date.now()): void {
    this.at.push(now);
    if (this.at.length > MOST) this.at.splice(0, this.at.length - MOST);
  }

  read(now = Date.now()): ReachNow {
    this.at = this.at.filter((t) => now - t <= HOUR);
    return { lastHour: this.at.length, lastAt: this.at.at(-1) ?? null, upMs: Math.max(0, now - this.startedAt) };
  }
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** The line `provider status` prints. Silence soon after a start says nothing yet; after two minutes it says what the
 * two possible reasons are, since a network with no router running looks the same from here as an unreachable address. */
export function reachLine(r: ReachNow, config: string, now = Date.now()): string {
  const label = '  checked from outside  ';
  if (r.lastAt !== null) return `${label}${r.lastHour.toLocaleString('en-US')} time${r.lastHour === 1 ? '' : 's'} in the last hour, the last ${ago(now - r.lastAt)} ago`;
  if (r.upMs < 120_000) return `${label}not yet, ${ago(r.upMs)} since this node started`;
  return `${label}not in the last hour. A router that knows this node asks every 30 s, so either none is running or the public address does not reach it: orrery provider check --config ${config}`;
}
