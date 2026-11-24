import type { Watched } from './watched.ts';

/** One node as a router saw it with its own checks and requests: how often the node was up when the router checked,
 * and how many of the requests the router sent it were answered. Nothing about the router's wallet, channels or
 * spending is in it, and nothing about what was asked. */
export type Note = { address: string; checks: number; up: number; sent: number; answered: number };

/** What a router shares with other routers when it is started with --share-notes (GET /orrery/notes). */
export type Notes = { notes: 1; at: number; nodes: Note[] };

/** The nodes a router has a record of, as notes. A node it has never checked or asked is left out. */
export function notesFrom(entries: { address: string; watched: Watched | null | undefined }[], now = Date.now()): Notes {
  const nodes = entries
    .filter((e) => e.watched && (e.watched.checks > 0 || (e.watched.sent ?? 0) > 0))
    .map((e) => ({ address: e.address, checks: e.watched!.checks, up: e.watched!.up, sent: e.watched!.sent ?? 0, answered: e.watched!.answered ?? 0 }));
  return { notes: 1, at: now, nodes };
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A peer's notes, read as data: anything that is not a well-formed note is dropped, and so is a note that says a node
 * was up more often than it was checked, or answered more than it was sent. At most 1,000 nodes are kept. */
export function parseNotes(j: unknown): Note[] | null {
  const n = j as Partial<Notes> | null;
  if (!n || typeof n !== 'object' || n.notes !== 1 || !Array.isArray(n.nodes)) return null;
  return n.nodes
    .filter((x): x is Note => !!x && typeof x === 'object' && typeof x.address === 'string' && base58.test(x.address)
      && count(x.checks) && count(x.up) && count(x.sent) && count(x.answered) && x.up <= x.checks && x.answered <= x.sent)
    .slice(0, 1000)
    .map((x) => ({ address: x.address, checks: x.checks, up: x.up, sent: x.sent, answered: x.answered }));
}

/** What the peers this router reads say about one node, added up; null when none of them has a note on it. */
export type PeerSum = { routers: number; checks: number; up: number; sent: number; answered: number };

export function sumPeers(peers: Map<string, Note[]>, address: string): PeerSum | null {
  const seen = [...peers.values()].flatMap((list) => list.filter((n) => n.address === address));
  if (!seen.length) return null;
  return seen.reduce((s, n) => ({ routers: s.routers + 1, checks: s.checks + n.checks, up: s.up + n.up, sent: s.sent + n.sent, answered: s.answered + n.answered }), { routers: 0, checks: 0, up: 0, sent: 0, answered: 0 });
}

/** "2 peer routers saw it up in 118 of 120 checks and answering 81 of 82 requests": what other routers saw, apart from
 * this router's own record. Empty when no peer has a note on the node. */
export function peerText(p: PeerSum | null | undefined): string {
  if (!p) return '';
  const parts = [
    p.checks ? `up in ${p.up.toLocaleString('en-US')} of ${p.checks.toLocaleString('en-US')} check${p.checks === 1 ? '' : 's'}` : '',
    p.sent ? `answering ${p.answered.toLocaleString('en-US')} of ${p.sent.toLocaleString('en-US')} request${p.sent === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length ? `${p.routers} peer router${p.routers === 1 ? '' : 's'} saw it ${parts.join(' and ')}` : '';
}
