// An MCP server on stdio in front of the local router, so an agent (Claude Desktop, Claude Code, any MCP client) can hand
// work to models on the network. Every call goes through the router, so each answer is routed and paid per answer
// exactly like a request from any other tool.
import { answeredText, span, watchedText } from './router/watched.ts';
import { billsText, skipNote, speedText, unansweredNote } from './spend.ts';
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
        task: { type: 'string', description: 'optional name for the job this call belongs to; every call with the same task draws from one budget' },
        task_budget: { type: 'number', description: 'the budget in dollars for that task, e.g. 0.05, sent with its first call; when it is spent the router refuses further calls under the task. Every answer and refusal under a task says what it has spent and has left' },
        node: { type: 'string', description: 'optional: ask this node only, by the name status lists (e.g. Orrery Seed) or by its address' },
        patience: { type: 'number', description: 'optional: seconds to wait for a node that is away, restarting say, before giving up, 0 to 30; 30 when not given, 0 to fail at once' },
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
        max_cost: { type: 'number', description: 'optional budget in dollars for this one call, e.g. 0.001; only providers whose worst case fits are used' },
        task: { type: 'string', description: 'optional name for the job this call belongs to; ask and embed calls with the same task draw from one budget' },
        task_budget: { type: 'number', description: 'the budget in dollars for that task, e.g. 0.05, sent with its first call; when it is spent the router refuses further calls under the task' },
        node: { type: 'string', description: 'optional: use this node only, by the name status lists (e.g. Orrery Seed) or by its address' },
        patience: { type: 'number', description: 'optional: seconds to wait for a node that is away, restarting say, before giving up, 0 to 30; 30 when not given, 0 to fail at once' },
      },
      required: ['model', 'input'],
    },
  },
  {
    name: 'quote',
    description: 'What one request would cost at every provider that lists a model, from the prices pinned on Solana, cheapest first, with the cached-input rate where one is listed, and what this router itself saw of each node: how often it was up, what it answered and how fast it started. Nothing is sent or paid. Use it to pick a model or a node, or check a job fits a budget before asking.',
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
    description: 'What the local router has spent today, the payment channels it has open, whether each node’s model server answers (the router skips one that is down), the last 24 hours of spend by model from its own log, every task with what it has spent and has left, and every agent with its limit for today (UTC) and what it has spent.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Answers one JSON-RPC message from an MCP client; null for notifications. */
export async function handle(msg: Json, router: string, fetchFn: Fetch, version: string, agent: string | null = null): Promise<Json | null> {
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
      return ok(await call(String(params.name), (params.arguments ?? {}) as Json, router, fetchFn, agent));
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } };
  }
}

async function call(name: string, a: Json, router: string, fetchFn: Fetch, agent: string | null) {
  try {
    if (name === 'ask') {
      if (typeof a.model !== 'string' || typeof a.prompt !== 'string') return text('ask needs a model and a prompt', true);
      const messages = [...(typeof a.system === 'string' ? [{ role: 'system', content: a.system }] : []), { role: 'user', content: a.prompt }];
      const headers = callHeaders(a, agent);
      const noSuchNode = await pinNode(a, headers, router, fetchFn);
      if (noSuchNode) return text(noSuchNode, true);
      const send = () => fetchFn(`${router}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: a.model, messages, max_tokens: Number(a.max_tokens ?? 1024) }) });
      const { r, j } = await sendPatiently<{ choices?: { message?: { content?: string }; finish_reason?: string }[]; error?: { code?: string; message?: string } }>(send, headers);
      const task = taskLine(a, r) + agentLine(agent, r);
      if (!r.ok) return text(`the router could not answer: ${j.error?.message ?? r.status}${task}`, true);
      const answer = j.choices?.[0]?.message?.content ?? '';
      // The model ran out of room. A reasoning model thinks first and that counts against the cap, so the whole cap can
      // go before a word of the answer: the agent is told which, instead of handed an empty or half answer in silence.
      const cap = Number(a.max_tokens ?? 1024), ranOut = j.choices?.[0]?.finish_reason === 'length';
      const shown = answer.trim() ? answer : ranOut ? `(no answer: the model used all ${cap} output tokens before it wrote one. A reasoning model thinks first and that counts. Ask again with a larger max_tokens.)` : '(the model returned an empty answer)';
      const cutOff = answer.trim() && ranOut ? `\n— stopped at max_tokens ${cap}, so the answer is cut off: ask with a larger max_tokens for all of it` : '';
      const cost = r.headers.get('x-orrery-cost');
      // What the node asked against what the prices it listed on chain come to: the router paid no more than those.
      const billed = r.headers.get('x-orrery-billed'), listed = r.headers.get('x-orrery-listed');
      const checked = billed === null || listed === null ? ''
        : Number(billed) > Number(listed) ? ` (it asked $${billed}; paid its listed price)`
        : Number(billed) < Number(listed) ? `, under its listed $${listed}` : ', what its listed prices come to';
      // Nodes that failed before this one answered: the router moved on, and a node that does not answer is not paid.
      const skippedN = Number(r.headers.get('x-orrery-skipped') ?? 0);
      const skipped = skippedN > 0 ? `\n— ${skippedN} node${skippedN === 1 ? '' : 's'} failed before this one answered; a node that does not answer is not paid` : '';
      // How soon the answer started, as the router timed it: a node's speed, answer by answer.
      const ttft = Number(r.headers.get('x-orrery-ttft-ms') ?? NaN);
      const started = Number.isFinite(ttft) && ttft >= 0 ? ` in ${ttft < 1000 ? `${Math.round(ttft)} ms` : `${(ttft / 1000).toFixed(1)} s`}` : '';
      // How this answer traveled, from the router's own headers: an agent can tell what the node's host could read.
      const payment = r.headers.get('x-orrery-payment') === 'inside' ? 'payment inside the seal' : 'payment in headers its host can read';
      const traveled = r.headers.get('x-orrery-sealed') === '1' ? `sealed to a verified enclave (${r.headers.get('x-orrery-enclave') ?? 'enclave'}), ${payment}`
        : r.headers.get('x-orrery-wire') === '1' ? `sealed to the node’s own key, ${payment}` : 'as plain JSON inside TLS, which the node’s host can read';
      return text(`${shown}\n\n— answered by ${answeredBy(r)}${started} via route ${r.headers.get('x-orrery-route') ?? 'auto'}, paid $${cost ?? '?'} for this answer${checked}${skipped}${cutOff}\n— traveled ${traveled}${task}`);
    }
    if (name === 'embed') {
      if (typeof a.model !== 'string' || (typeof a.input !== 'string' && !Array.isArray(a.input))) return text('embed needs a model and an input', true);
      const headers = callHeaders(a, agent);
      const noSuchNode = await pinNode(a, headers, router, fetchFn);
      if (noSuchNode) return text(noSuchNode, true);
      const { r, j } = await sendPatiently<{ data?: { embedding: number[] }[]; usage?: { prompt_tokens?: number }; error?: { code?: string; message?: string } }>(() => fetchFn(`${router}/v1/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model: a.model, input: a.input }) }), headers);
      const task = taskLine(a, r) + agentLine(agent, r);
      if (!r.ok) return text(`the router could not answer: ${j.error?.message ?? r.status}${task}`, true);
      const vectors = (j.data ?? []).map((d) => d.embedding);
      return text(`${JSON.stringify(vectors)}\n\n— ${vectors.length} vector${vectors.length === 1 ? '' : 's'} of ${vectors[0]?.length ?? 0} dimensions, ${j.usage?.prompt_tokens ?? '?'} input tokens, paid $${r.headers.get('x-orrery-cost') ?? '?'}, answered by ${answeredBy(r)}${task}`);
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
      const j = (await r.json()) as { spentToday?: string; channels?: { provider: string; spent: string; left: string }[]; providers?: { address: string; name: string | null; modelServer?: string | null; healthMs?: number | null; sealing?: string; redeems?: number; watched?: { checks: number; up: number; since: number; sent?: number; answered?: number; askedSince?: number } | null; observed?: { ok: number; fail: number; broke?: number } | null; answering?: boolean | null; unansweredSince?: number | null }[]; proxy?: string | null; proxySeen?: { node: string | null; address: string | null; givenAway: string | null } | null; privateOnly?: boolean; agents?: { name: string; cap: string | null; spent: string; left: string | null }[] };
      // How requests leave this computer, as the router last checked it from the far side.
      const seen = j.proxySeen;
      const leaving = !j.proxy ? 'no proxy, so nodes see the address this computer’s requests leave from (orrery router --proxy hides it)'
        : !seen?.address ? `through the proxy at ${j.proxy}; no node has said yet what address it sees`
        : seen.givenAway ? `through the proxy at ${j.proxy}, but ${seen.node ?? 'a node'} saw this computer’s own address (${seen.givenAway}); the router sends nothing until it does not`
        : `through the proxy at ${j.proxy}; ${seen.node ?? 'a node'} sees ${seen.address}`;
      const sealing: Record<string, string> = { inside: ', request and payment sealed to it', request: ', request sealed, payment in headers its host can read', plain: ', plain JSON its host can read', withheld: ', nothing sent: its wire key went missing' };
      const ch = (j.channels ?? []).map((c) => `${c.provider.slice(0, 6)}…  spent $${c.spent}, $${c.left} left`);
      const nodes = (j.providers ?? []).filter((p) => p.modelServer === 'up' || p.modelServer === 'down' || p.answering === false).map((p) => `${p.name ?? `${p.address.slice(0, 6)}…`}: ${p.answering === false ? `not answering health checks${typeof p.unansweredSince === 'number' ? ` for ${span(Date.now() - p.unansweredSince)}` : ''}` : `model server ${p.modelServer === 'up' ? `up${typeof p.healthMs === 'number' ? ` (${p.healthMs} ms)` : ''}` : 'down, skipped'}`}${sealing[p.sealing ?? ''] ?? ''}${typeof p.redeems === 'number' ? `, paid out ${p.redeems === 1 ? 'once' : `${p.redeems} times`} on chain` : ''}${watchedText(p.watched) ? `, ${watchedText(p.watched)}` : ''}${(answeredText(p.watched) || answeredText(p.observed)) ? `, ${answeredText(p.watched) || answeredText(p.observed)}` : ''}`);
      const sp = (await fetchFn(`${router}/orrery/spend?since=24h&by=model`).then((x) => (x.ok ? x.json() : null)).catch(() => null)) as { rows?: { key: string; answers: number; usd: string }[]; afterANodeDidNotAnswer?: { answers: number; nodes: number }; finishedByAnotherNode?: number; unanswered?: { requests: number; nodes: number }; speed?: { name: string; answers: number; medianTtftMs: number }[]; bills?: { name: string; checked: number; over: number }[] } | null;
      // How fast each node started answering, timed by this router: nobody reports it.
      const speed = (sp?.speed ?? []).map((s) => `${s.name} ${speedText(s)}`);
      // And each node's bills against the prices it listed on chain: the router pays no more than those prices.
      const billed = (sp?.bills ?? []).filter((b) => b.checked > 0).map((b) => `${b.name} ${billsText(b)}`);
      // Under the spend: answers that came from the next node after another did not answer. That node was signed nothing.
      const skips = sp?.afterANodeDidNotAnswer ? skipNote({ ...sp.afterANodeDidNotAnswer, resumed: sp.finishedByAnotherNode ?? 0 }) : '';
      // And requests no node answered at all: no voucher was signed for them.
      const unanswered = sp?.unanswered ? unansweredNote(sp.unanswered) : '';
      const byModel = (sp?.rows ?? []).map((r) => `${r.key}: ${r.answers} answer${r.answers === 1 ? '' : 's'}, $${r.usd}`);
      const tk = (await fetchFn(`${router}/orrery/tasks`).then((x) => (x.ok ? x.json() : null)).catch(() => null)) as { tasks?: { name: string; budget: string; spent: string; left: string; answers: number }[] } | null;
      const tasks = (tk?.tasks ?? []).slice(0, 10).map((t) => `${t.name}: $${t.spent} of $${t.budget} spent, $${t.left} left, ${t.answers} answer${t.answers === 1 ? '' : 's'}`);
      // Each agent's day, this server's own agent first. The limit is the router's, set where the router was started.
      const ags = [...(j.agents ?? [])].sort((x, y) => Number(y.name === agent) - Number(x.name === agent));
      const agents = ags.slice(0, 10).map((g) => `${g.name}${g.name === agent ? ' (this one)' : ''}: $${g.spent} spent today${g.cap === null ? ', no limit' : Number(g.left) > 0 ? ` of $${g.cap}, $${g.left} left` : ` of $${g.cap}, nothing left until 00:00 UTC`}`);
      const own = agent && !ags.some((g) => g.name === agent) ? `\nthis agent: ${agent}, nothing spent today` : '';
      return text(`spent today: $${j.spentToday ?? '0'}\nleaving this computer: ${leaving}${j.privateOnly ? '\nprivate only: every request goes sealed to an enclave this router verified, or not at all' : ''}\n${ch.length ? ch.join('\n') : 'no open channels'}${nodes.length ? `\nnodes:\n${nodes.join('\n')}` : ''}${byModel.length ? `\nlast 24h by model:\n${byModel.join('\n')}${skips ? `\n${skips}` : ''}${unanswered ? `\n${unanswered}` : ''}` : ''}${speed.length ? `\nspeed, by this router’s own clock:\n${speed.join('\n')}` : ''}${billed.length ? `\nbills, checked by this router against each node’s listed prices:\n${billed.join('\n')}` : ''}${tasks.length ? `\ntasks:\n${tasks.join('\n')}` : ''}${agents.length ? `\nagents, today (UTC):\n${agents.join('\n')}` : ''}${own}`);
    }
    return text(`unknown tool ${name}`, true);
  } catch (e) {
    // An agent passes this on to its user, so a router that is not running gets the command that starts one.
    const code = (e as { cause?: { code?: string } }).cause?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || (e as Error).message === 'fetch failed')
      return text(`no Orrery router is answering at ${router}. Start one with: npx -y orrery-node router --wallet <your keypair.json> (it pays providers from that wallet's USDC). If one runs elsewhere, start orrery mcp with --router <its address>.`, true);
    return text(`the router at ${router} answered with something unexpected: ${(e as Error).message}`, true);
  }
}

/** What ask and embed send alike: how long to wait for a node that is away, the task the call belongs to and its
 * budget, and the caps on what it may cost. */
function callHeaders(a: Json, agent: string | null): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(agent ? { 'x-orrery-agent': agent } : {}),
    'x-orrery-patience': patienceOf(a.patience),
    ...(typeof a.task === 'string' && a.task ? { 'x-orrery-task': a.task } : {}),
    ...(typeof a.task_budget === 'number' && a.task_budget > 0 ? { 'x-orrery-task-budget': String(a.task_budget) } : {}),
    ...(typeof a.max_price === 'string' && a.max_price ? { 'x-orrery-max-price': a.max_price } : {}),
    ...(typeof a.max_cost === 'number' && a.max_cost > 0 ? { 'x-orrery-max-cost': String(a.max_cost) } : {}),
  };
}

/** Staying with one node: an address goes as is; a name is looked up in the router's own list of nodes. Returns what
 * to tell the agent when no node has that name. */
async function pinNode(a: Json, headers: Record<string, string>, router: string, fetchFn: Fetch): Promise<string | null> {
  if (typeof a.node !== 'string' || !a.node.trim()) return null;
  const wanted = a.node.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wanted)) {
    headers['x-orrery-provider'] = wanted;
    return null;
  }
  const st = (await (await fetchFn(`${router}/orrery/status`)).json()) as { providers?: { address: string; name?: string | null }[] };
  const listed = st.providers ?? [];
  const hit = listed.find((p) => (p.name ?? '').toLowerCase() === wanted.toLowerCase());
  if (!hit) return `no node named ${wanted} is listed. The router knows: ${listed.map((p) => p.name ?? p.address).join(', ') || 'no nodes yet'}`;
  headers['x-orrery-provider'] = hit.address;
  return null;
}

/** Sends a call. When no node answered within the wait it is sent once more, since a restart can outlast one wait (the
 * seed's takes about 40 s), unless the agent asked not to wait at all. */
async function sendPatiently<T extends { error?: { code?: string } }>(send: () => ReturnType<Fetch>, headers: Record<string, string>) {
  let r = await send();
  let j = (await r.json()) as T;
  if (r.status === 502 && j.error?.code === 'all_failed' && headers['x-orrery-patience'] !== '0') {
    r = await send();
    j = (await r.json()) as T;
  }
  return { r, j };
}

type Answered = Awaited<ReturnType<Fetch>>;

/** Under a task, what it has spent and has left, from the router's own headers: after an answer and after a refusal. */
function taskLine(a: Json, r: Answered): string {
  const spent = r.headers.get('x-orrery-task-spent'), left = r.headers.get('x-orrery-task-left');
  return typeof a.task === 'string' && a.task && spent !== null && left !== null ? `\n— task ${a.task}: $${spent} spent, $${left} left` : '';
}

/** For an agent with a limit, what it has spent today and has left, from the router's own headers: after an answer
 * and after a refusal. */
function agentLine(agent: string | null, r: Answered): string {
  const spent = r.headers.get('x-orrery-agent-spent'), left = r.headers.get('x-orrery-agent-left');
  if (!agent || spent === null || left === null) return '';
  return `\n— agent ${agent}: $${spent} spent today, ${Number(left) > 0 ? `$${left} left` : 'nothing left until 00:00 UTC'}`;
}

/** The node that answered, by its name when it has one, from the router's own headers. */
function answeredBy(r: Answered): string {
  const who = r.headers.get('x-orrery-provider'), raw = r.headers.get('x-orrery-provider-name');
  const name = raw ? (() => { try { return decodeURIComponent(raw); } catch { return raw; } })() : null;
  return name && who ? `${name} (${who.slice(0, 6)}…)` : who ? `${who.slice(0, 6)}…` : 'a provider';
}

/** The x-orrery-patience an agent's call carries: its own 0 to 30 seconds, or 30. An agent would rather wait half a
 * minute for a node that is restarting than get an error it has to retry. */
export function patienceOf(p: unknown): string {
  return typeof p === 'number' && p >= 0 && p <= 30 ? String(p) : '30';
}

/** Runs the server on stdin/stdout: one JSON-RPC message per line, as the MCP stdio transport expects. */
export function serveMcp(router: string, version: string, fetchFn: Fetch = fetch as unknown as Fetch, agent: string | null = null) {
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
    const out = await handle(msg, router.replace(/\/$/, ''), fetchFn, version, agent);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
