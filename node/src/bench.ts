// `orrery bench <model>`: asks every provider that lists a model a few short questions through your own router, one
// provider at a time, and reports what you would get from each: first-token time, total time and what an answer cost.
// Each ask is a real, paid request. A model listed on input tokens only is an embedding model and is asked through
// /v1/embeddings.
import type { ProviderEntry } from './router/registry.ts';

export type BenchRow = { name: string; address: string; asked: number; answered: number; ttftMs: number[]; totalMs: number[]; units: bigint[]; price: { input: number; output: number } | null; error?: string };

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const toUnits = (usd: string | null) => {
  if (!usd) return 0n;
  const [w, f = ''] = usd.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};

/** provider init lists embedding models with an output price of zero; a chat model always charges for output. */
export const isEmbedding = (offer: { price: { output: number } } | undefined) => offer?.price.output === 0;

export async function bench(o: { model: string; providers: ProviderEntry[]; router: string; n: number; fetchFn?: Fetch; now?: () => number }): Promise<BenchRow[]> {
  const f = o.fetchFn ?? (fetch as unknown as Fetch);
  const now = o.now ?? (() => performance.now());
  const rows: BenchRow[] = [];
  for (const e of o.providers) {
    const offer = e.manifest?.models.find((m) => m.id === o.model);
    const row: BenchRow = { name: e.manifest?.name ?? e.address.slice(0, 8), address: e.address, asked: 0, answered: 0, ttftMs: [], totalMs: [], units: [], price: offer ? { input: offer.price.input, output: offer.price.output } : null };
    for (let i = 0; i < o.n; i++) {
      row.asked += 1;
      const t0 = now();
      try {
        const r = await f(`${o.router.replace(/\/$/, '')}/v1/${isEmbedding(offer) ? 'embeddings' : 'chat/completions'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-orrery-provider': e.address },
          body: JSON.stringify(isEmbedding(offer)
            ? { model: o.model, input: [`Benchmark ${i + 1}: a short passage to embed.`] }
            : { model: o.model, messages: [{ role: 'user', content: `Benchmark ${i + 1}: reply with one short sentence.` }], max_tokens: 32 }),
        });
        const j = (await r.json()) as { error?: { message?: string } };
        if (!r.ok) {
          row.error = j.error?.message ?? `router answered ${r.status}`;
          break;
        }
        row.answered += 1;
        row.totalMs.push(Math.round(now() - t0));
        const ttft = Number(r.headers.get('x-orrery-ttft-ms'));
        if (Number.isFinite(ttft) && ttft > 0) row.ttftMs.push(ttft);
        row.units.push(toUnits(r.headers.get('x-orrery-cost')));
      } catch (err) {
        row.error = (err as Error).message;
        break;
      }
    }
    rows.push(row);
  }
  return rows.sort((a, b) => (b.answered > 0 ? 1 : 0) - (a.answered > 0 ? 1 : 0) || median(a.ttftMs) - median(b.ttftMs));
}

export function renderBench(model: string, rows: BenchRow[]): string {
  const usd = (u: bigint) => `$${(Number(u) / 1e6).toFixed(6)}`;
  const per = (x: number) => `$${(x / 1e6).toFixed(x < 100_000 ? 4 : 2)}`;
  const lines = [`${model}, ${rows[0]?.asked ?? 0} asks per provider, through your router`];
  lines.push(`${'provider'.padEnd(22)}${'answered'.padStart(9)}${'first token'.padStart(13)}${'total'.padStart(9)}${'per answer'.padStart(13)}   listed in / out`);
  let spent = 0n;
  for (const r of rows) {
    const sum = r.units.reduce((a, b) => a + b, 0n);
    spent += sum;
    const mean = r.units.length ? sum / BigInt(r.units.length) : 0n;
    const listed = r.price ? `${per(r.price.input)} / ${per(r.price.output)}` : '';
    if (!r.answered) {
      lines.push(`${r.name.slice(0, 21).padEnd(22)}${`0/${r.asked}`.padStart(9)}   did not answer${r.error ? `: ${r.error.slice(0, 60)}` : ''}`);
      continue;
    }
    lines.push(`${r.name.slice(0, 21).padEnd(22)}${`${r.answered}/${r.asked}`.padStart(9)}${(r.ttftMs.length ? `${median(r.ttftMs)} ms` : '—').padStart(13)}${`${median(r.totalMs)} ms`.padStart(9)}${usd(mean).padStart(13)}   ${listed}`);
  }
  lines.push(`spent ${usd(spent)} on this bench`);
  return lines.join('\n');
}
