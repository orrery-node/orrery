// Where one answer's time went on this machine, in milliseconds.
//
//   route    choosing the node: listings already read from chain, ranked by price, speed, reputation and holder price
//   channel  making sure a payment channel to that node is open (a transaction the first time, nothing after)
//   seal     encrypting the request to the node's key
//   node     from sending until the node's first event came back: the network and the model
//   sign     signing the new running total once the answer is in
//
// No stage sends a transaction except opening a channel, which happens once per node. The first use of a channel
// after a start reads it once; a node re-reads a channel from chain at most every 30 seconds, inside `node`.
export type Timing = { route: number; channel: number; seal: number; node: number; sign: number };

export const STAGES = ['route', 'channel', 'seal', 'node', 'sign'] as const;

/** Thousandths of a millisecond are kept: three of the five stages are far under one. */
export function roundMs(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The standard Server-Timing header for the stages known so far (a stream's headers go out before `sign`). */
export function serverTiming(t: Partial<Timing>): string {
  return STAGES.filter((k) => typeof t[k] === 'number' && Number.isFinite(t[k]))
    .map((k) => `${k};dur=${roundMs(t[k]!)}`)
    .join(', ');
}

/** What this machine added to the answer: everything but the wait for the node. */
export function overheadMs(t: Timing): number {
  return roundMs(t.route + t.channel + t.seal + t.sign);
}
