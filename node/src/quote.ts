// `orrery quote <model>`: what a request would cost at every provider that lists the model, from the prices they
// published on chain, before anything is sent or paid. The same integer formula the router and provider settle with.
import { costOf, perMillion, usd } from './pricing.ts';
import { kindOf, type ModelKind } from './manifest.ts';
import type { ProviderEntry } from './router/registry.ts';

export type QuoteRow = { name: string; address: string; input: number; output: number; cachedInput: number | null; full: bigint; cached: bigint | null; enclave: boolean };

export function quote(providers: ProviderEntry[], model: string, inTokens: number, outTokens: number, cachedShare: number): QuoteRow[] {
  const rows: QuoteRow[] = [];
  for (const e of providers) {
    const offer = e.manifest?.models.find((m) => m.id === model);
    if (!offer) continue;
    const p = offer.price;
    rows.push({
      name: e.manifest?.name ?? e.address.slice(0, 8),
      address: e.address,
      input: p.input,
      output: p.output,
      cachedInput: p.cachedInput ?? null,
      full: costOf(p, inTokens, outTokens),
      cached: p.cachedInput === undefined ? null : costOf(p, inTokens, outTokens, Math.round(inTokens * cachedShare)),
      enclave: !!e.tee?.verified,
    });
  }
  return rows.sort((a, b) => (a.full < b.full ? -1 : a.full > b.full ? 1 : a.name.localeCompare(b.name)));
}

/** What a model is for, from its listings: the first kind other than chat that any listing says, else chat. */
export const quoteKind = (providers: ProviderEntry[], model: string): 'chat' | ModelKind =>
  providers.flatMap((e) => (e.manifest?.models ?? []).filter((m) => m.id === model)).map((m) => kindOf(m)).find((k) => k !== 'chat') ?? 'chat';

/** `saw` gives what this router saw of a node, by its address: empty when it has no record of it. `about` says what the
 * model is for when it is not chat, and for speech how many characters of text the tokens were counted from. */
export function renderQuote(model: string, inTokens: number, outTokens: number, cachedShare: number, rows: QuoteRow[], saw?: (address: string) => string, about?: { kind: 'chat' | ModelKind; chars?: number; images?: number }): string {
  if (!rows.length) return `No provider on the network lists ${model}. orrery models shows what is listed.`;
  const n = (x: number) => x.toLocaleString('en-US');
  const pct = Math.round(cachedShare * 100);
  const kind = about?.kind ?? 'chat';
  const size = kind === 'speech' && about?.chars !== undefined
    ? `${n(about.chars)} character${about.chars === 1 ? '' : 's'} of text, ${n(inTokens)} token${inTokens === 1 ? '' : 's'} in (one per 4 characters)`
    : kind === 'image' ? `${n(about?.images ?? 1)} image${(about?.images ?? 1) === 1 ? '' : 's'} (1,000 output tokens each), ${n(inTokens)} tokens of prompt`
    : kind === 'chat' ? `${n(inTokens)} tokens in, ${n(outTokens)} out` : `${n(inTokens)} tokens in`;
  const lines = [`${model} · ${kind === 'chat' ? '' : `${kind} · `}${size} · listed prices on Solana, before any holder discount`];
  const both = kind === 'chat' || kind === 'image';
  lines.push(`${'provider'.padEnd(22)}${(both ? 'in / out' : 'in').padStart(22)}${'this request'.padStart(15)}${`${pct}% cached`.padStart(15)}`);
  for (const r of rows) {
    const per = both ? `${perMillion(r.input)} / ${perMillion(r.output)}` : perMillion(r.input);
    lines.push(`${(r.enclave ? `${r.name.slice(0, 12)} ·enclave` : r.name.slice(0, 21)).padEnd(22)}${per.padStart(22)}${`$${usd(r.full)}`.padStart(15)}${(r.cached === null ? '—' : `$${usd(r.cached)}`).padStart(15)}`);
  }
  const seen = rows.flatMap((r) => { const said = saw?.(r.address) ?? ''; return said ? [`  ${r.name}  ${said}`] : []; });
  if (seen.length) lines.push('what your router saw of them:', ...seen);
  const best = rows[0];
  const thousand = best.full * 1000n;
  lines.push(`cheapest: ${best.name}, $${usd(best.full)} a request, $${usd(thousand, 2)} for a thousand like it. Nothing was sent or paid.`);
  // What keeping the prompt from the node's operator too costs: the cheapest node in an enclave this router verified.
  const sealed = rows.find((r) => r.enclave);
  if (sealed === best) lines.push(`${best.name} runs in an enclave this router verified, so :private costs the same.`);
  else if (sealed) lines.push(`with :private: ${sealed.name} runs in an enclave this router verified, $${usd(sealed.full)} a request${best.full > 0n ? ` (${(Number(sealed.full) / Number(best.full)).toFixed(1)}× the cheapest)` : ''}.`);
  return lines.join('\n');
}
