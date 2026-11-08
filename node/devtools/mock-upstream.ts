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

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    const ids = (process.env.MOCK_MODELS ?? 'llama3.1:8b,qwen2.5:7b').split(',');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id })) }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const inputs: string[] = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
    const vec = (text: string) => Array.from({ length: 8 }, (_, i) => Number((Math.sin(text.length * (i + 1)) / 2).toFixed(6)));
    const tokens = inputs.reduce((a, t) => a + Math.max(1, Math.ceil(t.length / 4)), 0);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: body.model, data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: vec(t) })), usage: { prompt_tokens: tokens, total_tokens: tokens } }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  const prompt = JSON.stringify(body.messages ?? '');
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
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
  frame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  frame({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: n - from, total_tokens: promptTokens + n - from, prompt_tokens_details: { cached_tokens: cachedTokens } } });
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`mock upstream ${label} on :${port} (delay ${delayMs}ms)`));
