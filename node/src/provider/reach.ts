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

  private reached = false;

  /** Counts one check from outside; true for the first since the node started. */
  note(now = Date.now()): boolean {
    this.at.push(now);
    if (this.at.length > MOST) this.at.splice(0, this.at.length - MOST);
    if (this.reached) return false;
    this.reached = true;
    return true;
  }

  get ever(): boolean {
    return this.reached;
  }

  read(now = Date.now()): ReachNow {
    this.at = this.at.filter((t) => now - t <= HOUR);
    return { lastHour: this.at.length, lastAt: this.at.at(-1) ?? null, upMs: Math.max(0, now - this.startedAt) };
  }
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** The node log's line the first time something outside reaches it: the first sign the public address works. */
export function firstReachNote(upMs: number): string {
  return `reached from outside ${ago(upMs)} after starting: the public address works, and routers that know this node check it every 30 s`;
}

/** The node log's line, once, when nothing outside has checked it three minutes after it started. */
export function quietNote(upMs: number): string {
  return `nothing outside this computer has checked this node in the ${ago(upMs)} since it started; routers that know it check every 30 s, so either none is running or the public address does not reach it: orrery provider check says which`;
}

/** The line `provider status` prints. Silence soon after a start says nothing yet; after two minutes it says what the
 * two possible reasons are, since a network with no router running looks the same from here as an unreachable address. */
export function reachLine(r: ReachNow, config: string, now = Date.now()): string {
  const label = '  checked from outside  ';
  if (r.lastAt !== null) return `${label}${r.lastHour.toLocaleString('en-US')} time${r.lastHour === 1 ? '' : 's'} in the last hour, the last ${ago(now - r.lastAt)} ago`;
  if (r.upMs < 120_000) return `${label}not yet, ${ago(r.upMs)} since this node started`;
  return `${label}not in the last hour. A router that knows this node asks every 30 s, so either none is running or the public address does not reach it: orrery provider check --config ${config}`;
}
