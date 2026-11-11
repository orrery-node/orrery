// The Anthropic Messages API on top of the router. Providers speak OpenAI chat completions, so a /v1/messages request
// is translated on the way in and the provider's stream is translated on the way out. Payment, routing and fall-through
// are the same as for /v1/chat/completions.

type Json = Record<string, unknown>;
type Block = { type: string; [k: string]: unknown };

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? (c as Block[]).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n\n') : '';

function imagePart(b: Block): Json | null {
  const src = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (src?.type === 'base64' && src.data) return { type: 'image_url', image_url: { url: `data:${src.media_type ?? 'image/png'};base64,${src.data}` } };
  if (src?.type === 'url' && src.url) return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

/** An Anthropic Messages request as the OpenAI chat request a provider understands. */
export function toOpenAI(a: Json): Json {
  const messages: Json[] = [];
  const system = textOf(a.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of (a.messages as { role: string; content: unknown }[] | undefined) ?? []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = (m.content as Block[] | undefined) ?? [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: (b.is_error ? 'Error: ' : '') + textOf(b.content) });
    }
    const parts = blocks.flatMap((b): Json[] => {
      if (b.type === 'text') return [{ type: 'text', text: String(b.text ?? '') }];
      if (b.type === 'image') return [imagePart(b)].filter((x): x is Json => x !== null);
      return [];
    });
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n\n') : parts });
  }
  const out: Json = { model: a.model, messages, max_tokens: a.max_tokens ?? 1024, stream: a.stream === true };
  if (a.temperature !== undefined) out.temperature = a.temperature;
  if (a.top_p !== undefined) out.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) out.stop = a.stop_sequences;
  // metadata.user_id (Claude Code: account, device and session) is not carried over: see identity.ts.
  const tools = (a.tools as { name: string; description?: string; input_schema?: Json }[] | undefined) ?? [];
  if (tools.length) out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } } }));
  const choice = a.tool_choice as { type?: string; name?: string } | undefined;
  if (choice?.type === 'auto') out.tool_choice = 'auto';
  if (choice?.type === 'any') out.tool_choice = 'required';
  if (choice?.type === 'none') out.tool_choice = 'none';
  if (choice?.type === 'tool' && choice.name) out.tool_choice = { type: 'function', function: { name: choice.name } };
  return out;
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

type Delta = { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
export type Chunk = { choices?: { index?: number; delta?: Delta; finish_reason?: string | null }[] };

/** Turns a provider's OpenAI stream into Anthropic stream events, written as they arrive. */
export class AnthropicStream {
  private open: { kind: 'text' | 'tool'; index: number; key?: number } | null = null;
  private next = 0;
  private stop = 'end_turn';

  constructor(private emit: (event: string, data: Json) => void, private id: string, private model: string, private estimatedInput: number) {}

  start() {
    this.emit('message_start', {
      type: 'message_start',
      message: { id: this.id, type: 'message', role: 'assistant', content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: this.estimatedInput, output_tokens: 0 } },
    });
  }

  private close() {
    if (!this.open) return;
    this.emit('content_block_stop', { type: 'content_block_stop', index: this.open.index });
    this.open = null;
  }

  chunk(c: Chunk) {
    for (const ch of c.choices ?? []) {
      if ((ch.index ?? 0) !== 0) continue;
      const d = ch.delta ?? {};
      if (d.content) {
        if (this.open?.kind !== 'text') {
          this.close();
          this.open = { kind: 'text', index: this.next++ };
          this.emit('content_block_start', { type: 'content_block_start', index: this.open.index, content_block: { type: 'text', text: '' } });
        }
        this.emit('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const t of d.tool_calls ?? []) {
        const key = t.index ?? 0;
        if (this.open?.kind !== 'tool' || this.open.key !== key) {
          this.close();
          this.open = { kind: 'tool', index: this.next++, key };
          this.emit('content_block_start', { type: 'content_block_start', index: this.open.index, content_block: { type: 'tool_use', id: t.id ?? `toolu_${this.id.slice(-12)}_${key}`, name: t.function?.name ?? '', input: {} } });
        }
        if (t.function?.arguments) this.emit('content_block_delta', { type: 'content_block_delta', index: this.open.index, delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
      }
      if (ch.finish_reason) this.stop = STOP[ch.finish_reason] ?? 'end_turn';
    }
  }

  finish(inputTokens: number, outputTokens: number) {
    this.close();
    this.emit('message_delta', { type: 'message_delta', delta: { stop_reason: this.stop, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
    this.emit('message_stop', { type: 'message_stop' });
  }
}

/** The whole provider stream as one Anthropic message, for a client that did not ask to stream. */
export function toMessage(chunks: Chunk[], id: string, model: string, inputTokens: number, outputTokens: number): Json {
  let text = '';
  let stop = 'end_turn';
  const tools = new Map<number, { id: string; name: string; args: string }>();
  for (const c of chunks) {
    for (const ch of c.choices ?? []) {
      if ((ch.index ?? 0) !== 0) continue;
      if (ch.delta?.content) text += ch.delta.content;
      for (const t of ch.delta?.tool_calls ?? []) {
        const k = t.index ?? 0;
        const cur = tools.get(k) ?? { id: t.id ?? `toolu_${id.slice(-12)}_${k}`, name: '', args: '' };
        if (t.function?.name) cur.name += t.function.name;
        if (t.function?.arguments) cur.args += t.function.arguments;
        tools.set(k, cur);
      }
      if (ch.finish_reason) stop = STOP[ch.finish_reason] ?? 'end_turn';
    }
  }
  const content: Json[] = [];
  if (text) content.push({ type: 'text', text });
  for (const [, t] of [...tools].sort((a, b) => a[0] - b[0])) {
    let input: unknown = {};
    try {
      input = t.args ? JSON.parse(t.args) : {};
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: t.id, name: t.name, input });
  }
  return { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

/** An error in the shape Anthropic clients parse. */
export function anthropicError(status: number, message: string): Json {
  const type = status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : 'api_error';
  return { type: 'error', error: { type, message } };
}
