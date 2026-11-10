// How the router picks a provider. Every route returns an ordered list, so a slow or failing provider falls
// through to the next one without the caller noticing.
import type { ModelOffer } from '../manifest.ts';
import { discounted } from '../holder.ts';
import { costOf } from '../pricing.ts';
import type { ProviderEntry } from './registry.ts';

export const ROUTES = ['auto', 'price', 'speed', 'reputation', 'privacy', 'burn'] as const;
export type Route = (typeof ROUTES)[number];

const SUFFIX: Record<string, Route> = { cheap: 'price', floor: 'price', fast: 'speed', trusted: 'reputation', private: 'privacy' };

/** `qwen3-32b:private` → model qwen3-32b on the privacy route. */
export function parseModel(raw: string, fallback: Route): { model: string; route: Route } {
  const at = raw.lastIndexOf(':');
  if (at > 0) {
    const s = raw.slice(at + 1).toLowerCase();
    if (SUFFIX[s]) return { model: raw.slice(0, at), route: SUFFIX[s] };
    if ((ROUTES as readonly string[]).includes(s)) return { model: raw.slice(0, at), route: s as Route };
  }
  return { model: raw, route: fallback };
}

/** Model aliases: `from=to` pairs, comma separated. A `from` ending in * matches any name with that prefix, so a
 * client that only knows its own model names (claude-*, gpt-*) can be pointed at a network model. */
export type Alias = { from: string; prefix: boolean; to: string };

export function parseAliases(spec: string | undefined): Alias[] {
  return (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    if (i <= 0 || i === p.length - 1) throw new Error(`alias "${p}" should look like from=to`);
    const from = p.slice(0, i).trim();
    return { from: from.endsWith('*') ? from.slice(0, -1) : from, prefix: from.endsWith('*'), to: p.slice(i + 1).trim() };
  });
}

export function applyAlias(model: string, aliases: Alias[] | undefined): string {
  for (const a of aliases ?? []) if (a.prefix ? model.startsWith(a.from) : model === a.from) return a.to;
  return model;
}

export type Observed = { ttftMs: number | null; ok: number; fail: number; cooldownUntil: number };

export class Stats {
  private m = new Map<string, Observed>();
  get(address: string): Observed {
    return this.m.get(address) ?? { ttftMs: null, ok: 0, fail: 0, cooldownUntil: 0 };
  }
  ok(address: string, ttftMs: number) {
    const o = this.get(address);
    o.ttftMs = o.ttftMs === null ? ttftMs : Math.round(o.ttftMs * 0.7 + ttftMs * 0.3);
    o.ok += 1;
    this.m.set(address, o);
  }
  /** Counts against this router's success rate without a cooldown: the provider answered, but not as it promised. */
  penalize(address: string) {
    const o = this.get(address);
    o.fail += 1;
    this.m.set(address, o);
  }
  fail(address: string) {
    const o = this.get(address);
    o.fail += 1;
    o.cooldownUntil = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(4, o.fail - 1));
    this.m.set(address, o);
  }
  all() {
    return this.m;
  }
}

const log01 = (x: number, cap: number) => Math.min(1, Math.log10(1 + Math.max(0, x)) / Math.log10(1 + cap));

/** 0..1 from what the chain proves (money actually settled, how often, for how long, what is bonded) and what this
 * router saw itself. Settled volume is weighted most because it is the only input that cost someone real USDC. */
export function reputation(e: ProviderEntry, o: Observed, maxBond: bigint): number {
  const a = e.account;
  const settled = log01(Number(a.settled) / 1e6, 1_000);
  const redeems = log01(Number(a.redeems), 1_000);
  const days = (Date.now() / 1000 - Number(a.registeredAt)) / 86_400;
  const age = Math.min(1, Math.max(0, days) / 90);
  const bond = maxBond > 0n ? Math.sqrt(Number((a.bonded * 1_000_000n) / maxBond) / 1_000_000) : 0;
  const seen = o.ok + o.fail;
  const local = seen === 0 ? 0.6 : o.ok / seen;
  return Math.min(1, 0.35 * settled + 0.15 * redeems + 0.15 * age + 0.1 * bond + 0.25 * local + 0.1 * burnScore(e));
}

/** 0..1 for a burn pledge this router verified on chain: how much of the pledge was kept, times the square root of the
 * pledged share, so a kept 25% counts for half of a kept 100%. An unverified or unkept pledge counts for nothing. */
export function burnScore(e: ProviderEntry): number {
  if (!e.manifest?.burn || !e.burn) return 0;
  return e.burn.kept * Math.sqrt(Math.min(10_000, e.burn.share) / 10_000);
}

/** A node counts as burning once this router has verified it kept at least 90% of what its pledge owes. */
export const burning = (e: ProviderEntry) => !!e.manifest?.burn && !!e.burn && e.burn.kept >= 0.9;

export type Candidate = { entry: ProviderEntry; offer: ModelOffer; expected: bigint; ttftMs: number | null; reputation: number; sealed: boolean; off: number; cached: number };

/** `offOf` is the holder discount this router's wallet earns at each provider (basis points), 0 when none. `cachedOf` is
 * how much of this prompt a provider likely still has in its prompt cache (see affinity.ts), priced at its cached rate. */
export function rank(offers: { entry: ProviderEntry; offer: ModelOffer }[], route: Route, estIn: number, estOut: number, stats: Stats, minReputation = 0, offOf: (e: ProviderEntry) => number = () => 0, cachedOf: (e: ProviderEntry) => number = () => 0): Candidate[] {
  const now = Date.now();
  const maxBond = offers.reduce((m, o) => (o.entry.account.bonded > m ? o.entry.account.bonded : m), 0n);
  let c: Candidate[] = offers
    .filter((o) => stats.get(o.entry.address).cooldownUntil <= now)
    .map(({ entry, offer }) => {
      const o = stats.get(entry.address);
      const off = offOf(entry);
      const cached = offer.price.cachedInput === undefined ? 0 : cachedOf(entry);
      return {
        entry,
        offer,
        off,
        cached,
        expected: costOf(discounted(offer.price, off), estIn, Math.min(estOut, offer.maxOutput), cached),
        ttftMs: o.ttftMs,
        reputation: reputation(entry, o, maxBond),
        sealed: route === 'privacy',
      };
    });
  if (route === 'privacy') c = c.filter((x) => x.entry.tee?.verified);
  if (route === 'burn') c = c.filter((x) => burning(x.entry));
  const byCost = (a: Candidate, b: Candidate) => (a.expected === b.expected ? b.reputation - a.reputation : a.expected < b.expected ? -1 : 1);
  const ttft = (x: Candidate) => x.ttftMs ?? 1_500;
  switch (route) {
    case 'price':
    case 'privacy':
      return c.sort(byCost);
    case 'speed':
      return c.sort((a, b) => ttft(a) - ttft(b) || byCost(a, b));
    case 'burn':
      return c.sort((a, b) => (b.entry.burn?.share ?? 0) - (a.entry.burn?.share ?? 0) || byCost(a, b));
    case 'reputation':
      return c.sort((a, b) => b.reputation - a.reputation || byCost(a, b));
    case 'auto': {
      const trusted = c.filter((x) => x.reputation >= minReputation);
      const pool = trusted.length ? trusted : c;
      const minCost = pool.reduce((m, x) => (x.expected < m ? x.expected : m), pool[0]?.expected ?? 0n);
      const minT = Math.min(...pool.map(ttft));
      const score = (x: Candidate) => 0.6 * (minCost > 0n ? Number(x.expected) / Number(minCost) : 1) + 0.25 * (ttft(x) / Math.max(1, minT)) + 0.15 * (1 - x.reputation) * 3;
      return pool.sort((a, b) => score(a) - score(b));
    }
  }
}

/** A price ceiling in USDC base units per million tokens, input and output. */
export type Ceiling = { input: number; output: number };

/** "0.50/1.50" (dollars per million tokens, input/output) as a ceiling; undefined when not given. */
export function parseCeiling(s: string | undefined): Ceiling | undefined {
  if (s === undefined || s === '') return undefined;
  const m = /^\s*\$?(\d+(?:\.\d+)?)\s*\/\s*\$?(\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) throw new Error(`a price ceiling looks like 0.50/1.50 (dollars per million tokens, input/output), not ${s}`);
  return { input: Math.round(Number(m[1]) * 1e6), output: Math.round(Number(m[2]) * 1e6) };
}

export function underCeiling(p: { input: number; output: number }, c: Ceiling | undefined): boolean {
  return !c || (p.input <= c.input && p.output <= c.output);
}
