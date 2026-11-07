// The OpenAI Responses API on top of the router (what newer clients such as the Codex CLI speak). Providers speak chat
// completions, so a /v1/responses request is translated on the way in and the provider's stream on the way out. Payment,
// routing, fall-through and resume are the same as for /v1/chat/completions.
import type { Chunk } from './anthropic.ts';

type Json = Record<string, unknown>;
type Part = { type?: string; text?: string; image_url?: string };

const partsText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? (c as Part[]).filter((p) => p.type === 'input_text' || p.type === 'output_text' || p.type === 'text').map((p) => p.text ?? '').join('') : '';

/** A Responses request as the chat request a provider understands. */
export function responsesToChat(a: Json): Json {
  const messages: Json[] = [];
  if (typeof a.instructions === 'string' && a.instructions) messages.push({ role: 'system', content: a.instructions });
  const input = typeof a.input === 'string' ? [{ role: 'user', content: a.input }] : ((a.input as Json[] | undefined) ?? []);
  for (const item of input) {
    const type = item.type as string | undefined;
    if (type === 'function_call') {
      const call = { id: String(item.call_id), type: 'function', function: { name: String(item.name), arguments: String(item.arguments ?? '{}') } };
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && !last.content && Array.isArray(last.tool_calls)) (last.tool_calls as unknown[]).push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      continue;
    }
    if (type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: String(item.call_id), content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
      continue;
    }
    if (type && type !== 'message') continue;
    const role = item.role === 'developer' ? 'system' : String(item.role ?? 'user');
    const images = Array.isArray(item.content) ? (item.content as Part[]).filter((p) => p.type === 'input_image' && p.image_url) : [];
    if (images.length && role === 'user') {
      const content = (item.content as Part[]).flatMap((p): Json[] => (p.type === 'input_image' && p.image_url ? [{ type: 'image_url', image_url: { url: p.image_url } }] : p.text ? [{ type: 'text', text: p.text }] : []));
      messages.push({ role, content });
    } else {
      messages.push({ role, content: partsText(item.content) });
    }
  }
  const out: Json = { model: a.model, messages, stream: a.stream === true, max_tokens: a.max_output_tokens ?? 1024 };
  if (a.temperature !== undefined) out.temperature = a.temperature;
  if (a.top_p !== undefined) out.top_p = a.top_p;
  if (typeof a.user === 'string') out.user = a.user;
  const tools = ((a.tools as Json[] | undefined) ?? []).filter((t) => t.type === 'function');
  if (tools.length) out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object' } } }));
  const choice = a.tool_choice as string | { type?: string; name?: string } | undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') out.tool_choice = choice;
  else if (choice && typeof choice === 'object' && choice.type === 'function' && choice.name) out.tool_choice = { type: 'function', function: { name: choice.name } };
  return out;
}

type Item = { kind: 'message'; id: string; text: string } | { kind: 'call'; id: string; callId: string; name: string; args: string };

/** Collects a provider's chunks into Responses output items, and writes Responses stream events as they happen. */
export class ResponsesStream {
  private items: Item[] = [];
  private open: { item: Item; index: number; key?: number } | null = null;
  private seq = 0;

  constructor(private emit: ((event: string, data: Json) => void) | null, private id: string, private model: string, private created = Math.floor(Date.now() / 1000)) {}

  private send(event: string, data: Json) {
    if (this.emit) this.emit(event, { type: event, sequence_number: this.seq++, ...data });
  }

  private shell(status: string, usage?: Json): Json {
    return { id: this.id, object: 'response', created_at: this.created, model: this.model, status, output: this.items.map((i) => this.render(i)), ...(usage ? { usage } : {}) };
  }

  private render(i: Item): Json {
    return i.kind === 'message'
      ? { type: 'message', id: i.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: i.text, annotations: [] }] }
      : { type: 'function_call', id: i.id, call_id: i.callId, name: i.name, arguments: i.args, status: 'completed' };
  }

  start() {
    this.send('response.created', { response: this.shell('in_progress') });
  }

  private close() {
    if (!this.open) return;
    const { item, index } = this.open;
    if (item.kind === 'message') {
      this.send('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.text });
      this.send('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: { type: 'output_text', text: item.text, annotations: [] } });
    } else {
      this.send('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.args });
    }
    this.send('response.output_item.done', { output_index: index, item: this.render(item) });
    this.open = null;
  }

  chunk(c: Chunk) {
    for (const ch of c.choices ?? []) {
      if ((ch.index ?? 0) !== 0) continue;
      const d = ch.delta ?? {};
      if (d.content) {
        if (this.open?.item.kind !== 'message') {
          this.close();
          const item: Item = { kind: 'message', id: `msg_${this.id.slice(5)}_${this.items.length}`, text: '' };
          this.items.push(item);
          this.open = { item, index: this.items.length - 1 };
          this.send('response.output_item.added', { output_index: this.open.index, item: { type: 'message', id: item.id, role: 'assistant', status: 'in_progress', content: [] } });
          this.send('response.content_part.added', { item_id: item.id, output_index: this.open.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        (this.open!.item as { text: string }).text += d.content;
        this.send('response.output_text.delta', { item_id: this.open!.item.id, output_index: this.open!.index, content_index: 0, delta: d.content });
      }
      for (const t of d.tool_calls ?? []) {
        const key = t.index ?? 0;
        if (this.open?.item.kind !== 'call' || this.open.key !== key) {
          this.close();
          const item: Item = { kind: 'call', id: `fc_${this.id.slice(5)}_${this.items.length}`, callId: t.id ?? `call_${this.id.slice(-8)}_${key}`, name: t.function?.name ?? '', args: '' };
          this.items.push(item);
          this.open = { item, index: this.items.length - 1, key };
          this.send('response.output_item.added', { output_index: this.open.index, item: { type: 'function_call', id: item.id, call_id: item.callId, name: item.name, arguments: '', status: 'in_progress' } });
        }
        const it = this.open!.item as Extract<Item, { kind: 'call' }>;
        if (t.function?.name && !it.name) it.name = t.function.name;
        if (t.function?.arguments) {
          it.args += t.function.arguments;
          this.send('response.function_call_arguments.delta', { item_id: it.id, output_index: this.open!.index, delta: t.function.arguments });
        }
      }
    }
  }

  /** Ends the stream and returns the finished response object (also what a non-streaming client gets). */
  finish(inputTokens: number, outputTokens: number): Json {
    this.close();
    const done = this.shell('completed', { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens });
    this.send('response.completed', { response: done });
    return done;
  }
}
