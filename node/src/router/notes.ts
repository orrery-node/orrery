import bs58 from 'bs58';
import { ed25519Verify, type Sign } from '../keys.ts';
import type { Watched } from './watched.ts';

/** One node as a router saw it with its own checks and requests: how often the node was up when the router checked,
 * and how many of the requests the router sent it were answered. Nothing about the router's wallet, channels or
 * spending is in it, and nothing about what was asked. */
export type Note = { address: string; checks: number; up: number; sent: number; answered: number };

/** What a router shares with other routers when it is started with --share-notes (GET /orrery/notes): signed with
 * the router's session key (`by`), so a reader knows which router said it and that nothing was changed on the way. */
export type Notes = { notes: 1; at: number; nodes: Note[]; by?: string; sig?: string };

/** The bytes a router signs: a fixed prefix and the notes in a fixed key order. */
export function notesMessage(at: number, nodes: Note[]): Uint8Array {
  const body = JSON.stringify({ at, nodes: nodes.map((n) => ({ address: n.address, checks: n.checks, up: n.up, sent: n.sent, answered: n.answered })) });
  return Buffer.concat([Buffer.from('orrery/notes/1'), Buffer.from(body)]);
}

/** Notes signed by a router: `by` is its session key, `sig` the ed25519 signature over notesMessage. */
export function signNotes(n: Notes, by: string, sign: Sign): Notes {
  return { ...n, by, sig: Buffer.from(sign(notesMessage(n.at, n.nodes))).toString('base64') };
}

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
  return wellFormed(n.nodes);
}

function wellFormed(nodes: unknown[]): Note[] {
  return (nodes as Partial<Note>[])
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

/** A peer's notes with who signed them. `signed` is true only when the signature checks against `by` over the notes as
 * they arrived (before anything was dropped); with a key pinned for the peer (`--peer url#<key>`), notes signed by any
 * other key, or not signed, are refused outright. Unsigned notes from an unpinned peer are read, and said to be. */
export type PeerNotes = { by: string | null; signed: boolean; nodes: Note[] };

/** Notes older than this when they arrive are not used: a signature says who wrote them, not that they are current,
 * and anyone can pass old signed notes on again. */
export const NOTES_MAX_AGE_MS = 3_600_000;

export function readPeerNotes(j: unknown, pinned?: string, now = Date.now()): PeerNotes | { refused: string } {
  const n = j as Partial<Notes> | null;
  if (!n || typeof n !== 'object' || n.notes !== 1 || !Array.isArray(n.nodes) || typeof n.at !== 'number') return { refused: 'not notes' };
  const asSent = n.nodes as Note[];
  let signed = false;
  if (typeof n.by === 'string' && typeof n.sig === 'string') {
    try {
      signed = ed25519Verify(bs58.decode(n.by), notesMessage(n.at, asSent), Buffer.from(n.sig, 'base64'));
    } catch {
      signed = false;
    }
    if (!signed) return { refused: 'the signature does not match the notes' };
  }
  if (pinned && (!signed || n.by !== pinned)) return { refused: signed ? `signed by ${n.by}, not the router pinned for this peer` : 'not signed, and this peer is pinned to a key' };
  if (n.at > now + 60_000) return { refused: 'the notes are dated in the future' };
  if (now - n.at > NOTES_MAX_AGE_MS) return { refused: `the notes are ${Math.round((now - n.at) / 60_000)} min old; older than an hour is not used` };
  return { by: signed ? (n.by as string) : null, signed, nodes: wellFormed(asSent) };
}

/** How many routers one router reads on its peers' word (--meet-peers), on top of the ones it was given. */
export const MEET_MAX = 8;

/** What a router serves at /orrery/peers when it shares notes: the routers it reads whose notes it could check, each
 * with the key that signed them, so a router that meets them through it can pin them to that key. */
export type Introductions = { peers: { url: string; by: string }[] };

/** A peer's introductions, read as data: http(s) addresses without a key part, each with a well-formed key; anything
 * else is dropped, and at most 32 are kept. Each comes back as `url#key`, the form --peer pins a peer with. */
export function readIntroductions(j: unknown): string[] {
  const list = (j as Partial<Introductions> | null)?.peers;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const p of list as { url?: unknown; by?: unknown }[]) {
    if (!p || typeof p.url !== 'string' || typeof p.by !== 'string' || !base58.test(p.by)) continue;
    if (!/^https?:\/\/[^\s#]{1,200}$/.test(p.url)) continue;
    const key = `${p.url.replace(/\/$/, '')}#${p.by}`;
    if (!out.includes(key)) out.push(key);
    if (out.length === 32) break;
  }
  return out;
}
