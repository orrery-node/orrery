// An MCP server on stdio in front of the local router, so an agent (Claude Desktop, Claude Code, any MCP client) can hand
// work to models on the network. Every call goes through the router, so each answer is routed and paid per answer
// exactly like a request from any other tool.
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

const TOOLS = [
  {
    name: 'ask',
    description: 'Ask a model on the Orrery network. The local router picks a provider listed on Solana and pays it for this one answer. Add :cheap, :fast, :trusted or :private to the model name to pick the route, and max_price to cap what you pay per million tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'a network model id, e.g. llama-3.3-70b or deepseek-v3:cheap' },
        prompt: { type: 'string', description: 'what to ask' },
        system: { type: 'string', description: 'optional system prompt' },
        max_tokens: { type: 'number', description: 'cap on the answer length (default 1024)' },
        max_price: { type: 'string', description: 'optional price ceiling in dollars per million tokens, input/output, e.g. 0.50/1.50; no provider above it is used' },
        max_cost: { type: 'number', description: 'optional budget in dollars for this one answer, e.g. 0.001; only providers whose worst case fits are used' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'embed',
    description: 'Turn text into vectors with an embedding model on the Orrery network, paid for this one call. Returns the vectors as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'a network embedding model id, e.g. bge-m3' },
        input: { description: 'a string or an array of strings', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        max_price: { type: 'string', description: 'optional price ceiling in dollars per million input tokens, written input/output, e.g. 0.05/0' },
      },
      required: ['model', 'input'],
    },
  },
  {
    name: 'quote',
    description: 'What one request would cost at every provider that lists a model, from the prices pinned on Solana, cheapest first, with the cached-input rate where one is listed. Nothing is sent or paid. Use it to pick a model or check a job fits a budget before asking.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'a network model id, e.g. gpt-oss-120b' },
        input_tokens: { type: 'number', description: 'tokens the model will read (default 2000)' },
        output_tokens: { type: 'number', description: 'tokens it will write (default 500)' },
        prompt: { type: 'string', description: 'instead of input_tokens: the prompt, to estimate from' },
        cached_share: { type: 'number', description: 'share of the input resent from a prompt cache, 0 to 1 (default 0.8)' },
      },
      required: ['model'],
    },
  },
  {
    name: 'models',
    description: 'List the models on the Orrery network with the cheapest price per million tokens, the cheapest cached-input price where one is listed, context length, and how many providers serve each. Prices come from listings pinned on Solana.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'What the local router has spent today, the payment channels it has open, and the last 24 hours of spend by model from its own log.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Answers one JSON-RPC message from an MCP client; null for notifications. */
export async function handle(msg: Json, router: string, fetchFn: Fetch, version: string): Promise<Json | null> {
  const id = msg.id;
  if (id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: (params.protocolVersion as string) ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'orrery', version } });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return ok(await call(String(params.name), (params.arguments ?? {}) as Json, router, fetchFn));
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
  }
}

async function call(name: string, a: Json, router: string, fetchFn: Fetch) {
  try {
    if (name === 'ask') {
      if (typeof a.model !== 'string' || typeof a.prompt !== 'string') return text('ask needs a model and a prompt', true);
      const messages = [...(typeof a.system === 'string' ? [{ role: 'system', content: a.system }] : []), { role: 'user', content: a.prompt }];
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(typeof a.max_price === 'string' && a.max_price ? { 'x-orrery-max-price': a.max_price } : {}), ...(typeof a.max_cost === 'number' && a.max_cost > 0 ? { 'x-orrery-max-cost': String(a.max_cost) } : {}) };
      const r = await fetchFn(`${router}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: a.model, messages, max_tokens: Number(a.max_tokens ?? 1024) }) });
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      if (!r.ok) return text(`the router could not answer: ${j.error?.message ?? r.status}`, true);
      const answer = j.choices?.[0]?.message?.content ?? '';
      const who = r.headers.get('x-orrery-provider');
      const cost = r.headers.get('x-orrery-cost');
      return text(`${answer}\n\n— answered by ${who ? `${who.slice(0, 6)}…` : 'a provider'} via route ${r.headers.get('x-orrery-route') ?? 'auto'}, paid $${cost ?? '?'} for this answer`);
    }
    if (name === 'embed') {
      if (typeof a.model !== 'string' || (typeof a.input !== 'string' && !Array.isArray(a.input))) return text('embed needs a model and an input', true);
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(typeof a.max_price === 'string' && a.max_price ? { 'x-orrery-max-price': a.max_price } : {}) };
      const r = await fetchFn(`${router}/v1/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model: a.model, input: a.input }) });
      const j = (await r.json()) as { data?: { embedding: number[] }[]; usage?: { prompt_tokens?: number }; error?: { message?: string } };
      if (!r.ok) return text(`the router could not answer: ${j.error?.message ?? r.status}`, true);
      const vectors = (j.data ?? []).map((d) => d.embedding);
      return text(`${JSON.stringify(vectors)}\n\n— ${vectors.length} vector${vectors.length === 1 ? '' : 's'} of ${vectors[0]?.length ?? 0} dimensions, ${j.usage?.prompt_tokens ?? '?'} input tokens, paid $${r.headers.get('x-orrery-cost') ?? '?'}`);
    }
    if (name === 'quote') {
      if (typeof a.model !== 'string') return text('quote needs a model', true);
      const q = new URLSearchParams({ model: a.model });
      if (typeof a.prompt === 'string') q.set('prompt', a.prompt);
      if (typeof a.input_tokens === 'number') q.set('in', String(a.input_tokens));
      if (typeof a.output_tokens === 'number') q.set('out', String(a.output_tokens));
      if (typeof a.cached_share === 'number') q.set('cached', String(a.cached_share));
      const r = await fetchFn(`${router}/orrery/quote?${q}`);
      const j = (await r.json()) as { text?: string; error?: { message?: string } };
      return r.ok ? text(j.text ?? '') : text(`the router could not quote: ${j.error?.message ?? r.status}`, true);
    }
    if (name === 'models') {
      const r = await fetchFn(`${router}/v1/models`);
      const j = (await r.json()) as { data?: { id: string; providers: number; context_length?: number; pricing: { prompt_per_million: number; completion_per_million: number; cached_prompt_per_million?: number } }[] };
      const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
      const rows = (j.data ?? []).map((m) => `${m.id}  ·  ${m.providers} provider${m.providers === 1 ? '' : 's'}  ·  from ${usd(m.pricing.prompt_per_million)} in / ${usd(m.pricing.completion_per_million)} out per million${m.pricing.cached_prompt_per_million !== undefined ? ` · cached in from ${usd(m.pricing.cached_prompt_per_million)}` : ''}${m.context_length ? `  ·  ${m.context_length.toLocaleString('en-US')} context` : ''}`);
      return text(rows.length ? rows.join('\n') : 'no models on the network right now');
    }
    if (name === 'status') {
      const r = await fetchFn(`${router}/orrery/status`);
      const j = (await r.json()) as { spentToday?: string; channels?: { provider: string; spent: string; left: string }[] };
      const ch = (j.channels ?? []).map((c) => `${c.provider.slice(0, 6)}…  spent $${c.spent}, $${c.left} left`);
      const sp = (await fetchFn(`${router}/orrery/spend?since=24h&by=model`).then((x) => (x.ok ? x.json() : null)).catch(() => null)) as { rows?: { key: string; answers: number; usd: string }[] } | null;
      const byModel = (sp?.rows ?? []).map((r) => `${r.key}: ${r.answers} answer${r.answers === 1 ? '' : 's'}, $${r.usd}`);
      return text(`spent today: $${j.spentToday ?? '0'}\n${ch.length ? ch.join('\n') : 'no open channels'}${byModel.length ? `\nlast 24h by model:\n${byModel.join('\n')}` : ''}`);
    }
    return text(`unknown tool ${name}`, true);
  } catch (e) {
    return text(`is the router running at ${router}? ${(e as Error).message}`, true);
  }
}

/** Runs the server on stdin/stdout: one JSON-RPC message per line, as the MCP stdio transport expects. */
export function serveMcp(router: string, version: string, fetchFn: Fetch = fetch as unknown as Fetch) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const out = await handle(msg, router.replace(/\/$/, ''), fetchFn, version);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
