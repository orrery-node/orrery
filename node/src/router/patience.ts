// A node that restarts is away for a few seconds. A router that fails the request in that gap, and then refuses the
// node for a cooldown, turns a blip into an outage on a network where a model has one node. This file says which
// failures mean "not there right now", and how long a request waits before it goes round again.
import { ChannelUnknown } from './channels.ts';

const AWAY = /fetch failed|ECONN\w+|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|timeout after \d+ ?ms|the proxy at .* (did not answer|closed the connection|refused a tunnel)|provider answered 50[234]\b/;

/** Whether a failure means the node could not be reached (or something in front of it answered for it), as opposed to
 * the node answering and refusing. Only the first kind is worth asking again a moment later. */
export function away(err: unknown): boolean {
  if (err instanceof ChannelUnknown) return true;
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  return AWAY.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''} ${e?.cause?.code ?? ''}`);
}

/** The waits between rounds. A round is added only while the request has been open for less than `patienceMs`. */
export const ROUNDS = [1_500, 3_000];

/** How long to wait before the next round, or null when the request has waited long enough. */
export function nextWait(round: number, elapsedMs: number, patienceMs: number): number | null {
  const wait = ROUNDS[round];
  return wait !== undefined && elapsedMs + wait <= patienceMs ? wait : null;
}
