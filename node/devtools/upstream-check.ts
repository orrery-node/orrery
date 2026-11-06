// Checks a provider config's upstream before it goes live: one short streamed request per model, exactly as the node
// would send it (whitelisted body, operator fields, headers). Prints first-token time, the usage the upstream
// reported, what our price list charges for it, and what the upstream says it cost (OpenRouter reports usage.cost).
//   ORRERY_UPSTREAM_KEY_FILE=../.local/openrouter.key npx tsx devtools/upstream-check.ts deploy/seed-provider.json
import { readFileSync } from 'node:fs';
import { costOf, usd } from '../src/pricing.ts';
import { upstreamBody, type ProviderConfig } from '../src/provider/node.ts';
import { readSse } from '../src/sse.ts';

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'deploy/seed-provider.json', 'utf8')) as ProviderConfig;
const keyFile = process.env.ORRERY_UPSTREAM_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, 'utf8').trim() : cfg.upstream.apiKeyEnv ? process.env[cfg.upstream.apiKeyEnv] : cfg.upstream.apiKey;
if (!key) throw new Error('no upstream key: set ORRERY_UPSTREAM_KEY_FILE or the config env var');

type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };
let failed = 0;
for (const m of cfg.models) {
  const body = { ...(cfg.upstream.body ?? {}), ...upstreamBody({ messages: [{ role: 'user', content: 'In one sentence: what is a payment channel?' }], models: ['ignored/should-not-pass'], n: 3 }, m.upstreamModel ?? m.id, 120) };
  const t0 = Date.now();
  let ttft = 0;
  let text = '';
  let usage: Usage | null = null;
  let served = '';
  try {
    const r = await fetch(`${cfg.upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(cfg.upstream.headers ?? {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    for await (const ev of readSse(r.body)) {
      if (ev.data === '[DONE]') break;
      let c: Record<string, unknown>;
      try {
        c = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (c.model) served = String(c.model);
      if (c.usage) usage = c.usage as Usage;
      for (const ch of (c.choices as { delta?: { content?: string } }[] | undefined) ?? []) {
        if (ch.delta?.content) {
          if (!ttft) ttft = Date.now() - t0;
          text += ch.delta.content;
        }
      }
    }
    const inT = usage?.prompt_tokens ?? 0, outT = usage?.completion_tokens ?? 0;
    const ours = costOf(m.price, inT, outT);
    const theirs = usage?.cost !== undefined ? BigInt(Math.ceil(usage.cost * 1e6)) : null;
    const margin = theirs !== null ? (theirs > 0n ? `${(Number(ours - theirs) / Number(theirs) * 100).toFixed(0)}%` : 'n/a') : 'no cost reported';
    const ok = !!usage && text.length > 0 && (theirs === null || ours >= theirs);
    if (!ok) failed++;
    console.log(`${ok ? '✓' : '✗'} ${m.id.padEnd(14)} → ${served.padEnd(36)} ttft ${String(ttft).padStart(5)} ms  ${inT}+${outT} tok  ours $${usd(ours)}  upstream ${theirs !== null ? `$${usd(theirs)}` : '?'}  margin ${margin}`);
    console.log(`    ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${m.id}: ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
