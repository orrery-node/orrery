// `orrery provider compare`: a node's price list next to every other listing of the same models on the network, so an
// operator can see where each model would rank before registering or changing prices. Reads chain listings only.
import { costOf, perMillion, usd } from '../pricing.ts';
import type { ProviderEntry } from '../router/registry.ts';

type Price = { input: number; output: number; cachedInput?: number };
export type CompareRow = { model: string; mine: Price; others: number; cheaper: number; lowest: Price | null; myCost: bigint; lowestCost: bigint | null };

/** Cost of a typical request (2,000 tokens in, 500 out) is how the :cheap route compares listings. */
export function compare(mine: { id: string; price: Price }[], network: ProviderEntry[], self: string | null, inTokens = 2000, outTokens = 500): CompareRow[] {
  return mine.map((m) => {
    const others = network
      .filter((e) => e.address !== self)
      .map((e) => e.manifest?.models.find((x) => x.id === m.id)?.price)
      .filter((p): p is Price => !!p);
    const myCost = costOf(m.price, inTokens, outTokens);
    const costs = others.map((p) => ({ p, c: costOf(p, inTokens, outTokens) })).sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
    return {
      model: m.id,
      mine: m.price,
      others: others.length,
      cheaper: costs.filter((x) => x.c < myCost).length,
      lowest: costs[0]?.p ?? null,
      myCost,
      lowestCost: costs[0]?.c ?? null,
    };
  });
}

export function renderCompare(name: string, rows: CompareRow[]): string {
  const lines = [`"${name}" against the network · a 2,000-in / 500-out request, as the :cheap route compares them`];
  lines.push(`${'model'.padEnd(26)}${'yours in / out'.padStart(22)}${'per request'.padStart(13)}   where it stands`);
  for (const r of rows) {
    const yours = `${perMillion(r.mine.input)} / ${perMillion(r.mine.output)}`;
    let stand: string;
    if (!r.others) stand = 'nobody else lists it: you would be the only one';
    else if (!r.cheaper) stand = `cheapest of ${r.others + 1}${r.lowestCost !== null && r.lowestCost > r.myCost ? `, $${usd(r.lowestCost - r.myCost)} under the next` : ''}`;
    else stand = `${r.cheaper} of ${r.others} cheaper; lowest ${perMillion(r.lowest!.input)} / ${perMillion(r.lowest!.output)} ($${usd(r.lowestCost!)})`;
    lines.push(`${r.model.slice(0, 25).padEnd(26)}${yours.padStart(22)}${`$${usd(r.myCost)}`.padStart(13)}   ${stand}`);
  }
  return lines.join('\n');
}
