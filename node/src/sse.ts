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

/** Reads what is left of a stream until it ends or `ms` pass. True if it ended. */
async function readOut(events: AsyncIterator<unknown>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const left = until - Date.now();
    const next = left > 0 ? await nextWithin(events, left) : null;
    if (!next) return false;
    if (next.done) return true;
  }
}

/** A node's answer, event by event, up to its `[DONE]`. After that the node ends the answer, and the stream is read
 * on to that end: stopping at `[DONE]` instead drops a stream that is not quite finished, which closes the
 * connection, and the next request then pays for a new one and a new TLS handshake.
 *
 * The end usually arrives within milliseconds, so it is waited for briefly (`waitMs`): the connection is then free
 * for what the router sends next. A node slow to end is not waited on. The caller gets its answer, and the rest is
 * read in the background for `graceMs` before the stream is let go. */
export async function* answerEvents(body: ReadableStream<Uint8Array>, o: { waitMs?: number; graceMs?: number } = {}): AsyncGenerator<SseEvent> {
  const events = readSse(body)[Symbol.asyncIterator]();
  let settled = false;
  try {
    for (;;) {
      const next = await events.next();
      if (next.done) {
        settled = true;
        return;
      }
      if (next.value.data === '[DONE]') break;
      yield next.value;
    }
    settled = await readOut(events, o.waitMs ?? 150);
    if (!settled) {
      settled = true;
      void readOut(events, o.graceMs ?? 1_000)
        .then((ended) => (ended ? undefined : events.return?.(undefined)))
        .catch(() => undefined);
    }
  } finally {
    // Left early (the caller stopped before [DONE]): let go of the stream.
    if (!settled) void events.return?.(undefined);
  }
}
