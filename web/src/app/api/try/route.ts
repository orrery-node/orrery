// POST /api/try — one question, answered by a provider on Solana mainnet and paid per answer by the site's router.
// GET  /api/try — whether the demo router is up, how many providers it sees, and what it has spent today.
import { DEMO_MODELS, DEMO_PORT, demo, warm } from '@/lib/demo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PER_IP = 5;
const WINDOW_MS = 10 * 60_000;
const PER_DAY = 300;
const MAX_PROMPT = 400;

const hits = new Map<string, number[]>();
let day = { key: '', n: 0 };
let queue: Promise<unknown> = Promise.resolve();

const usd = (units: bigint) => `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, '0')}`;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function allow(ip: string): string | null {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (day.key !== today) day = { key: today, n: 0 };
  if (day.n >= PER_DAY) return 'The demo has answered its share for today. Run your own router with npx -y orrery-node router.';
  const mine = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= PER_IP) return 'Five questions per ten minutes from one address. Your own router has no such limit.';
  mine.push(now);
  hits.set(ip, mine);
  day.n += 1;
  return null;
}

export async function GET() {
  const d = await demo();
  if (!d) return json(200, { online: false });
  return json(200, { online: true, providers: d.registry.usable().length, wallet: d.wallet, spentToday: usd(d.channels.todaySpent()), cap: '0.500000' });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { prompt?: unknown; model?: unknown } | null;
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const model = typeof body?.model === 'string' && (DEMO_MODELS as readonly string[]).includes(body.model) ? body.model : DEMO_MODELS[0];
  if (!prompt) return json(400, { error: 'Ask something first.' });
  if (prompt.length > MAX_PROMPT) return json(400, { error: `Keep it under ${MAX_PROMPT} characters.` });
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
  const refused = allow(ip);
  if (refused) return json(429, { error: refused });
  const d = await demo();
  if (!d) return json(503, { error: 'The demo router is offline right now.' });

  const ask = () =>
    fetch(`http://127.0.0.1:${DEMO_PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 220,
        messages: [
          { role: 'system', content: 'Answer plainly in under 90 words.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  const run = async () => {
    const t0 = Date.now();
    let r = await ask();
    let j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { code?: string; message?: string } };
    if (!r.ok && /simulation failed|blockhash|cooling down|all providers failed/i.test(j.error?.message ?? '')) {
      await warm(d);
      r = await ask();
      j = (await r.json().catch(() => ({}))) as typeof j;
    }
    if (!r.ok) {
      const budget = j.error?.code === 'budget';
      return json(budget ? 429 : 502, { error: budget ? 'The demo has spent its $0.50 for today. Run your own router with npx -y orrery-node router.' : `The network could not answer: ${j.error?.message ?? r.status}` });
    }
    const trip = d.router.trips[d.router.trips.length - 1];
    const ch = d.channels.list().find((c) => c.provider === trip?.provider);
    return json(200, {
      answer: j.choices?.[0]?.message?.content ?? '',
      model: trip?.model ?? model,
      route: trip?.route ?? 'auto',
      provider: { address: trip?.provider, name: trip?.providerName },
      inputTokens: trip?.inputTokens ?? 0,
      outputTokens: trip?.outputTokens ?? 0,
      cost: trip?.cost ?? null,
      ttftMs: trip?.ttftMs ?? null,
      totalMs: Date.now() - t0,
      holderOff: trip?.off ?? 0,
      channel: ch ? { address: ch.channel, deposit: usd(ch.deposit), signed: usd(ch.cumulative) } : null,
      payer: d.wallet,
      spentToday: usd(d.channels.todaySpent()),
    });
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  try {
    return await result;
  } catch (e) {
    return json(502, { error: `The network could not answer: ${(e as Error).message}` });
  }
}
