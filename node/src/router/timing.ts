// Where one answer's time went, in milliseconds.
//
// On this machine:
//   route    choosing the node: listings already read from chain, ranked by price, speed, reputation and holder price
//   channel  making sure a payment channel to that node is open (a transaction the first time, nothing after)
//   seal     encrypting the request to the node's key
//   node     from sending until the node's first event came back: the network, the node and the model
//   sign     signing the new running total once the answer is in
//
// Inside `node`, as the node itself reports it (a node's own account; older nodes report nothing):
//   node-open      decrypting the request
//   node-check     its payment checks: the channel, the last voucher, the holder price
//   node-upstream  its model server, from the request to the first sign of an answer
//
// No stage sends a transaction except opening a channel, which happens once per node. The first use of a channel
// after a start reads it once; a node re-reads a channel from chain at most every 30 seconds, inside `node-check`.
export type Timing = { route: number; channel: number; seal: number; node: number; sign: number; nodeOpen?: number; nodeCheck?: number; nodeUpstream?: number };
export type NodeTiming = { open: number; check: number; upstream: number };

export const STAGES = ['route', 'channel', 'seal', 'node', 'sign'] as const;

const NAMES: [keyof Timing, string][] = [
  ['route', 'route'], ['channel', 'channel'], ['seal', 'seal'], ['node', 'node'],
  ['nodeOpen', 'node-open'], ['nodeCheck', 'node-check'], ['nodeUpstream', 'node-upstream'], ['sign', 'sign'],
];

/** Thousandths of a millisecond are kept: most stages are far under one. */
export function roundMs(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The standard Server-Timing header for the stages known so far (a stream's headers go out before `sign`). */
export function serverTiming(t: Partial<Timing>): string {
  return NAMES.filter(([k]) => finite(t[k]))
    .map(([k, name]) => `${name};dur=${roundMs(t[k]!)}`)
    .join(', ');
}

/** What a node puts on its answer: its own three stages. */
export function nodeTimingHeader(t: NodeTiming): string {
  return `open;dur=${roundMs(t.open)}, check;dur=${roundMs(t.check)}, upstream;dur=${roundMs(t.upstream)}`;
}

/** Reads a node's account of its own stages from its Server-Timing header. Anything missing, negative or absurd is
 * left out: these numbers are the node's word, shown as such and used for nothing else. */
export function nodeSaid(header: string | null | undefined): Pick<Timing, 'nodeOpen' | 'nodeCheck' | 'nodeUpstream'> {
  const out: Pick<Timing, 'nodeOpen' | 'nodeCheck' | 'nodeUpstream'> = {};
  for (const part of (header ?? '').split(',')) {
    const m = /^\s*(open|check|upstream)\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)\s*$/.exec(part);
    if (!m) continue;
    const v = Number(m[2]);
    if (!finite(v) || v > 600_000) continue;
    out[m[1] === 'open' ? 'nodeOpen' : m[1] === 'check' ? 'nodeCheck' : 'nodeUpstream'] = roundMs(v);
  }
  return out;
}

/** What this machine added to the answer: everything but the wait for the node. */
export function overheadMs(t: Timing): number {
  return roundMs(t.route + t.channel + t.seal + t.sign);
}
