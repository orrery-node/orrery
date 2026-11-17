// What a node says when its model server turns a request away. The server's own words stay out of the log and out of
// the answer: some servers quote the request back, and a node may not read its requests (sealed ones above all). What
// the node keeps is the kind of refusal, in words its operator can act on.

export type Refusal = { status: number; code: string; message: string; log: string };

const LONGER = /maximum context length|context length|context window|max_model_len|too long|exceeds? the (model'?s? )?(maximum )?context/i;

export function refusal(status: number, text: string, offer: { id: string; upstreamModel?: string; context: number }): Refusal {
  const name = offer.upstreamModel ?? offer.id;
  if (status === 400 && LONGER.test(text)) {
    return { status: 400, code: 'context_length_exceeded', message: 'the model server refused the prompt as longer than it serves',
      log: `the model server refused a ${offer.id} request as longer than it serves (${status}); provider.json lists ${offer.context.toLocaleString('en-US')} tokens of context for it: set "context" to what the server serves (orrery provider check compares them)` };
  }
  const upstream = (log: string) => ({ status: 502, code: 'upstream_error', message: `upstream answered ${status}`, log });
  if (status === 404 || /not found|does not exist|unknown model/i.test(text)) return upstream(`the model server does not know ${name} (${status}): check "upstreamModel" for ${offer.id} in provider.json (orrery provider check lists what the server serves)`);
  if (status === 401 || status === 403) return upstream(`the model server refused the node’s key (${status}): check upstream.apiKey or upstream.apiKeyEnv in provider.json`);
  if (status === 429 || status === 503) return upstream(`the model server is busy (${status}) and turned a ${offer.id} request away`);
  return upstream(`the model server answered ${status} to a ${offer.id} request`);
}
