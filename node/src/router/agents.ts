// Agent wallets: one router wallet, many agents, each with its own spending limit per UTC day. A request names its
// agent with x-orrery-agent (or, for tools that only take a key, the key agent/<name>); the router keeps what each
// agent spent today and refuses the next request once that agent's limit would be passed. Limits are set when the
// router starts (--agent-cap researcher=0.50,coder=2). Today's spend is read back from the router's own log of
// answers, so a restart does not reset it.
import { existsSync } from 'node:fs';
import { readTrips } from '../spend.ts';

const NAME = /^[A-Za-z0-9._:\-]{1,64}$/;
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const units = (usd: string) => {
  const [w, f = ''] = usd.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};

/** An agent named in the API key, for tools that cannot add headers: `agent/<name>`. */
export function agentFromKey(key: string | null | undefined): string | null {
  const m = /^agent\/([A-Za-z0-9._:\-]{1,64})$/.exec((key ?? '').trim());
  return m ? m[1] : null;
}

/** "researcher=0.50,coder=2" as limits in USDC base units; throws on anything else, so a typo stops the router at start. */
export function parseAgentCaps(s: string | undefined): Map<string, bigint> {
  const caps = new Map<string, bigint>();
  if (!s?.trim()) return caps;
  for (const part of s.split(',')) {
    const m = /^\s*([A-Za-z0-9._:\-]{1,64})\s*=\s*\$?(\d+(?:\.\d{1,6})?)\s*$/.exec(part);
    if (!m || Number(m[2]) <= 0) throw new Error(`--agent-cap takes name=dollars a day, comma-separated (researcher=0.50,coder=2), not "${part.trim()}"`);
    caps.set(m[1], units(m[2]));
  }
  return caps;
}

export class AgentBook {
  private today = '';
  private spent = new Map<string, bigint>();

  constructor(readonly caps: Map<string, bigint>, private log: string | null = null) {}

  static valid(name: string) {
    return NAME.test(name);
  }

  /** The day's spend per agent, from the log of answers when the UTC day changes (and at the first request). */
  private roll(now: number) {
    const d = day(now);
    if (d === this.today) return;
    this.today = d;
    this.spent = new Map();
    if (!this.log || !existsSync(this.log)) return;
    for (const t of readTrips(this.log) as { at: number; cost: string; agent?: string }[]) {
      if (!t.agent || day(t.at) !== d) continue;
      this.spent.set(t.agent, (this.spent.get(t.agent) ?? 0n) + units(t.cost));
    }
  }

  /** What this agent may still spend today; null when it has no limit. */
  left(name: string, now = Date.now()): { cap: bigint; spent: bigint; left: bigint } | null {
    this.roll(now);
    const cap = this.caps.get(name);
    if (cap === undefined) return null;
    const spent = this.spent.get(name) ?? 0n;
    return { cap, spent, left: cap > spent ? cap - spent : 0n };
  }

  spend(name: string, amount: bigint, now = Date.now()) {
    this.roll(now);
    this.spent.set(name, (this.spent.get(name) ?? 0n) + amount);
  }

  /** Every agent with a limit, and every agent that spent today without one. */
  list(now = Date.now()): { name: string; cap: bigint | null; spent: bigint }[] {
    this.roll(now);
    const names = new Set([...this.caps.keys(), ...this.spent.keys()]);
    return [...names].sort().map((name) => ({ name, cap: this.caps.get(name) ?? null, spent: this.spent.get(name) ?? 0n }));
  }
}
