// A stand-in for vLLM/Ollama: an OpenAI-compatible server that streams a deterministic reply with real usage
// numbers, after a configurable delay. Used by the local end-to-end run so the network can be exercised without GPUs.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9000);
const delayMs = Number(process.argv[3] ?? 50);
const label = process.argv[4] ?? 'mock';

const words = 'Requests travel from your computer to a provider and back; the router signs a running total and the provider redeems it on Solana.'.split(' ');

// Like a model server with prefix caching: a request whose first message this server has seen before reports those
// tokens as cached (usage.prompt_tokens_details.cached_tokens), the way vLLM and hosted APIs do.
const seenPrefixes = new Set<string>();
// Which fields that identify an end user this server was ever sent (the rehearsal expects none).
const seenIdentity = new Set<string>();
const noteIdentity = (body: Record<string, unknown>) => { for (const k of ['user', 'metadata', 'safety_identifier', 'prompt_cache_key']) if (body[k] !== undefined) seenIdentity.add(k); };

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    const ids = (process.env.MOCK_MODELS ?? 'llama3.1:8b,qwen2.5:7b').split(',');
    // MOCK_MAX_MODEL_LEN makes it say, as vLLM and SGLang do, how many tokens of context each model is served with.
    const served = Number(process.env.MOCK_MAX_MODEL_LEN ?? 0);
    // MOCK_OWNED_BY says who owns each model, as Ollama does with the model's namespace ("library").
    const owner = process.env.MOCK_OWNED_BY;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, ...(owner ? { object: 'model', owned_by: owner } : {}), ...(served > 0 ? { max_model_len: served } : {}) })) }));
    return;
  }
  if (req.method === 'GET' && req.url?.endsWith('/seen-identity')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ label, fields: [...seenIdentity] }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    noteIdentity(body);
    const inputs: string[] = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
    const vec = (text: string) => Array.from({ length: 8 }, (_, i) => Number((Math.sin(text.length * (i + 1)) / 2).toFixed(6)));
    const tokens = inputs.reduce((a, t) => a + Math.max(1, Math.ceil(t.length / 4)), 0);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: body.model, data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: vec(t) })), usage: { prompt_tokens: tokens, total_tokens: tokens } }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/rerank')) {
    // A reranker in the query-and-documents shape: each document scored by the words it shares with the query.
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    noteIdentity(body);
    const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const q = words(String(body.query ?? ''));
    const docs: string[] = (Array.isArray(body.documents) ? body.documents : []).map((d: unknown) => (typeof d === 'string' ? d : String((d as { text?: string })?.text ?? '')));
    const scored = docs.map((d, index) => ({ index, relevance_score: Number(([...words(d)].filter((w) => q.has(w)).length / Math.max(1, q.size)).toFixed(6)), ...(body.return_documents ? { document: { text: d } } : {}) })).sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
    const tokens = [String(body.query ?? ''), ...docs].reduce((a, t) => a + Math.max(1, Math.ceil(t.length / 4)), 0);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `rerank-${Date.now()}`, model: body.model, results: typeof body.top_n === 'number' ? scored.slice(0, body.top_n) : scored, usage: { total_tokens: tokens } }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  noteIdentity(body);
  const prompt = JSON.stringify(body.messages ?? '');
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  // With MOCK_MAX_MODEL_LEN a prompt and its max_tokens beyond that are refused the way vLLM refuses them.
  const limit = Number(process.env.MOCK_MAX_MODEL_LEN ?? 0), asked = Number(body.max_tokens ?? 64);
  if (limit > 0 && promptTokens + asked > limit) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'error', message: `This model's maximum context length is ${limit} tokens. However, you requested ${promptTokens + asked} tokens (${promptTokens} in the messages, ${asked} in the completion). Please reduce the length of the messages or completion.`, type: 'BadRequestError', param: null, code: 400 }));
    return;
  }
  const max = Math.min(Number(body.max_tokens ?? 64), 64);
  const n = Math.min(words.length, Math.max(4, Math.min(max, 24)));
  const msgs = (body.messages ?? []) as { role: string; content: unknown }[];
  const last = msgs[msgs.length - 1];
  const first = JSON.stringify(msgs[0] ?? '');
  const cachedTokens = seenPrefixes.has(first) ? Math.min(promptTokens, Math.floor(first.length / 4)) : 0;
  seenPrefixes.add(first);
  // A final assistant message is a partial answer to continue (assistant prefill): pick up after the words it holds.
  const from = last?.role === 'assistant' ? String(last.content).split(' ').filter(Boolean).length : 0;
  // "[die-mid]" in the prompt makes a fresh request drop its connection five words in, like a provider that died.
  const dies = from === 0 && JSON.stringify(msgs).includes('[die-mid]');
  await new Promise((r) => setTimeout(r, delayMs));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const id = `chatcmpl-${label}-${Date.now()}`;
  const frame = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  frame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (let i = from; i < n; i++) {
    if (dies && i === 5) {
      await new Promise((r) => setTimeout(r, 150));
      res.socket?.destroy();
      return;
    }
    frame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: null }] });
  }
  // Like a real model server: a reply the cap cut short ends with finish_reason length.
  frame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: n < words.length ? 'length' : 'stop' }] });
  frame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: n - from, total_tokens: promptTokens + n - from, prompt_tokens_details: { cached_tokens: cachedTokens } } });
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`mock upstream ${label} on :${port} (delay ${delayMs}ms)`));
