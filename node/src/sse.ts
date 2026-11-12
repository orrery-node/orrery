// Minimal server-sent events reader for fetch() bodies, enough for OpenAI-style streams plus our own `orrery` event.
export type SseEvent = { event: string | null; data: string };

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | null = null;
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = null;
        data = [];
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (data.length) yield { event, data: data.join('\n') };
}

export function sseFrame(data: string, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${data}\n\n`;
}

export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${init.timeoutMs ?? 10_000}ms`)), init.timeoutMs ?? 10_000);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** The next event of a stream, or null if it does not come within `ms`. */
export async function nextWithin<T>(events: AsyncIterator<T>, ms: number): Promise<IteratorResult<T> | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([events.next(), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lets go of an answer nobody will read. An unread body holds its connection: this ends it now instead of when
 * something times out. */
export function drop(r: { body?: { cancel(): Promise<void> } | null }): void {
  void r.body?.cancel().catch(() => undefined);
}

/** Reads an answer to its end and throws it away, so the connection it came on can carry the next request. */
export async function finish(r: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<void> {
  await r.arrayBuffer().catch(() => undefined);
}

/** A node's answer, event by event, up to its `[DONE]`. After that the node ends the answer, and this reads on to
 * that end (for `graceMs` at most) before it returns. Stopping at `[DONE]` instead drops a stream that is not quite
 * finished, which closes the connection: the next request then pays for a new one and a new TLS handshake. */
export async function* answerEvents(body: ReadableStream<Uint8Array>, graceMs = 1_000): AsyncGenerator<SseEvent> {
  const events = readSse(body)[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      const next = await events.next();
      if (next.done) {
        finished = true;
        return;
      }
      if (next.value.data === '[DONE]') break;
      yield next.value;
    }
    for (;;) {
      const next = await nextWithin(events, graceMs);
      if (!next) return;
      if (next.done) {
        finished = true;
        return;
      }
    }
  } finally {
    // Left early (the caller stopped, or the node kept the stream open past the grace): let go of the stream.
    if (!finished) void events.return?.(undefined);
  }
}
