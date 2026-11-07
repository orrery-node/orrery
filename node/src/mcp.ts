// An MCP server on stdio in front of the local router, so an agent (Claude Desktop, Claude Code, any MCP client) can hand
// work to models on the network. Every call goes through the router, so each answer is routed and paid per answer
// exactly like a request from any other tool.
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

const TOOLS = [
  {
    name: 'ask',
    description: 'Ask a model on the Orrery network. The local router picks a provider listed on Solana and pays it for this one answer. Add :cheap, :fast, :trusted or :private to the model name to pick the route.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'a network model id, e.g. llama-3.3-70b or deepseek-v3:cheap' },
        prompt: { type: 'string', description: 'what to ask' },
        system: { type: 'string', description: 'optional system prompt' },
        max_tokens: { type: 'number', description: 'cap on the answer length (default 1024)' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'models',
    description: 'List the models on the Orrery network with the cheapest price per million tokens and how many providers serve each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'What the local router has spent today and the payment channels it has open.',
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
      const r = await fetchFn(`${router}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: a.model, messages, max_tokens: Number(a.max_tokens ?? 1024) }) });
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      if (!r.ok) return text(`the router could not answer: ${j.error?.message ?? r.status}`, true);
      const answer = j.choices?.[0]?.message?.content ?? '';
      const who = r.headers.get('x-orrery-provider');
      const cost = r.headers.get('x-orrery-cost');
      return text(`${answer}\n\n— answered by ${who ? `${who.slice(0, 6)}…` : 'a provider'} via route ${r.headers.get('x-orrery-route') ?? 'auto'}, paid $${cost ?? '?'} for this answer`);
    }
    if (name === 'models') {
      const r = await fetchFn(`${router}/v1/models`);
      const j = (await r.json()) as { data?: { id: string; providers: number; pricing: { prompt_per_million: number; completion_per_million: number } }[] };
      const rows = (j.data ?? []).map((m) => `${m.id}  ·  ${m.providers} provider${m.providers === 1 ? '' : 's'}  ·  $${m.pricing.prompt_per_million.toFixed(3)} in / $${m.pricing.completion_per_million.toFixed(3)} out per million`);
      return text(rows.length ? rows.join('\n') : 'no models on the network right now');
    }
    if (name === 'status') {
      const r = await fetchFn(`${router}/orrery/status`);
      const j = (await r.json()) as { spentToday?: string; channels?: { provider: string; spent: string; left: string }[] };
      const ch = (j.channels ?? []).map((c) => `${c.provider.slice(0, 6)}…  spent $${c.spent}, $${c.left} left`);
      return text(`spent today: $${j.spentToday ?? '0'}\n${ch.length ? ch.join('\n') : 'no open channels'}`);
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
