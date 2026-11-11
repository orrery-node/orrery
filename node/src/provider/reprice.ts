// `orrery provider price`: set a node's prices against the open market. Every listing's price list is public, so an
// operator can undercut the cheapest by a chosen margin without going under their own floor. Prices only ever go
// down here; raising them is a decision, not a default.
import { costOf, perMillion, usd } from '../pricing.ts';
import type { ProviderEntry } from '../router/registry.ts';

type Price = { input: number; output: number; cachedInput?: number };
export type RepriceRow = { model: string; from: Price; to: Price; changed: boolean; rival: string | null; note: string };

const IN = 2000, OUT = 500;

export function reprice(mine: { id: string; price: Price }[], network: ProviderEntry[], self: string | null, o: { beatPct: number; floor?: { input: number; output: number } }): RepriceRow[] {
  return mine.map((m) => {
    const rivals = network
      .filter((e) => e.address !== self)
      .map((e) => ({ name: e.manifest?.name ?? e.address.slice(0, 6), p: e.manifest?.models.find((x) => x.id === m.id)?.price }))
      .filter((r): r is { name: string; p: Price } => !!r.p)
      .map((r) => ({ ...r, c: costOf(r.p, IN, OUT) }))
      .sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
    const best = rivals[0];
    if (!best) return { model: m.id, from: m.price, to: m.price, changed: false, rival: null, note: 'nobody else lists it; the price is yours to set' };
    const cut = (v: number) => Math.floor((v * (100 - o.beatPct)) / 100);
    let input = cut(best.p.input), output = cut(best.p.output), floored = false;
    if (o.floor && (input < o.floor.input || output < o.floor.output)) {
      input = Math.max(input, o.floor.input);
      output = Math.max(output, o.floor.output);
      floored = true;
    }
    const target: Price = { input, output };
    const mineCost = costOf(m.price, IN, OUT), targetCost = costOf(target, IN, OUT);
    if (targetCost >= mineCost) {
      const ahead = mineCost < best.c;
      return { model: m.id, from: m.price, to: m.price, changed: false, rival: best.name, note: floored && !ahead ? `your floor keeps you above ${best.name} (${perMillion(best.p.input)} / ${perMillion(best.p.output)})` : ahead ? `already cheapest, $${usd(best.c - mineCost)} a request under ${best.name}` : `already at the target against ${best.name}` };
    }
    if (m.price.cachedInput !== undefined) target.cachedInput = Math.min(input, m.price.input > 0 ? Math.floor((m.price.cachedInput * input) / m.price.input) : 0);
    const under = targetCost < best.c;
    return { model: m.id, from: m.price, to: target, changed: true, rival: best.name, note: floored ? `held at your floor, ${under ? `$${usd(best.c - targetCost)} a request under` : 'level with or above'} ${best.name}` : `${o.beatPct}% under ${best.name} (${perMillion(best.p.input)} / ${perMillion(best.p.output)})` };
  });
}

export function renderReprice(name: string, rows: RepriceRow[], wrote: boolean): string {
  const pair = (p: Price) => `${perMillion(p.input)} / ${perMillion(p.output)}`;
  const lines = [`"${name}" against every other listing on chain · prices per million tokens, input / output`];
  lines.push(`${'model'.padEnd(22)}${'now'.padStart(20)}${''.padStart(4)}${'new'.padStart(20)}   why`);
  for (const r of rows) lines.push(`${r.model.slice(0, 21).padEnd(22)}${pair(r.from).padStart(20)}${(r.changed ? '→' : '=').padStart(3)} ${(r.changed ? pair(r.to) : 'unchanged').padStart(20)}   ${r.note}`);
  const n = rows.filter((r) => r.changed).length;
  lines.push(!n ? 'Nothing to change.' : wrote ? `${n} price${n === 1 ? '' : 's'} written. Pin the new list on chain with orrery provider register, then restart the node.` : `${n} price${n === 1 ? '' : 's'} would change. Run again with --write to save them to your provider.json.`);
  return lines.join('\n');
}
