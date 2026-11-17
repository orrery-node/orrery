// What a node says when its model server turns a request away. The server's own words stay out of the log and out of
// the answer: some servers quote the request back, and a node may not read its requests (sealed ones above all). What
// the node keeps is the kind of refusal, in words its operator can act on.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type RefusalKind = 'too_long' | 'unknown_model' | 'key' | 'busy' | 'other';
export type Refusal = { status: number; code: string; message: string; log: string; kind: RefusalKind };

const LONGER = /maximum context length|context length|context window|max_model_len|too long|exceeds? the (model'?s? )?(maximum )?context/i;

export function refusal(status: number, text: string, offer: { id: string; upstreamModel?: string; context: number }): Refusal {
  const name = offer.upstreamModel ?? offer.id;
  if (status === 400 && LONGER.test(text)) {
    return { kind: 'too_long', status: 400, code: 'context_length_exceeded', message: 'the model server refused the prompt as longer than it serves',
      log: `the model server refused a ${offer.id} request as longer than it serves (${status}); provider.json lists ${offer.context.toLocaleString('en-US')} tokens of context for it: set "context" to what the server serves (orrery provider check compares them)` };
  }
  const upstream = (kind: RefusalKind, log: string): Refusal => ({ kind, status: 502, code: 'upstream_error', message: `upstream answered ${status}`, log });
  if (status === 404 || /not found|does not exist|unknown model/i.test(text)) return upstream('unknown_model', `the model server does not know ${name} (${status}): check "upstreamModel" for ${offer.id} in provider.json (orrery provider check lists what the server serves)`);
  if (status === 401 || status === 403) return upstream('key', `the model server refused the node’s key (${status}): check upstream.apiKey or upstream.apiKeyEnv in provider.json`);
  if (status === 429 || status === 503) return upstream('busy', `the model server is busy (${status}) and turned a ${offer.id} request away`);
  return upstream('other', `the model server answered ${status} to a ${offer.id} request`);
}

/** A refusal as the node keeps it: when, for which model, of which kind. Never what the server said. */
export type Refused = { at: number; model: string; kind: RefusalKind };

export function appendRefused(path: string, r: Refused, rollBytes = 1024 * 1024) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && statSync(path).size >= rollBytes) renameSync(path, `${path}.1`);
    appendFileSync(path, `${JSON.stringify({ at: r.at, model: r.model, kind: r.kind })}\n`);
  } catch {
    // the log line already said it
  }
}

export function readRefused(path: string): Refused[] {
  const text = [`${path}.1`, path].filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8')).join('\n');
  return text.split('\n').flatMap((line) => {
    try {
      const r = JSON.parse(line) as Refused;
      return typeof r.at === 'number' && typeof r.kind === 'string' ? [r] : [];
    } catch {
      return [];
    }
  });
}

export function refusedCounts(list: Refused[], sinceMs: number, now = Date.now()): Partial<Record<RefusalKind, number>> {
  const out: Partial<Record<RefusalKind, number>> = {};
  for (const r of list) if (now - r.at <= sinceMs) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}

const SAID: Record<RefusalKind, string> = { too_long: 'longer than it serves', unknown_model: 'for a model it does not know', key: 'with the node’s key refused', busy: 'busy', other: 'other' };

/** "3 in the last 24 h: 2 longer than it serves, 1 busy", or "none in the last 24 h". */
export function refusedText(c: Partial<Record<RefusalKind, number>>): string {
  const kinds = (Object.keys(SAID) as RefusalKind[]).filter((k) => (c[k] ?? 0) > 0);
  const total = kinds.reduce((n, k) => n + (c[k] ?? 0), 0);
  return total ? `${total} in the last 24 h: ${kinds.map((k) => `${c[k]} ${SAID[k]}`).join(', ')}` : 'none in the last 24 h';
}
