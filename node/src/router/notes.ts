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

/** What a router kept of its peers' notes before a restart (peer -> the notes as they arrived), read again as if they had
 * just arrived: only for peers it is still given, each checked again (the signature, the pinned key) and dropped once it
 * is over an hour old. A file that does not read as that keeps nothing. */
export function keptPeerNotes(text: string, given: Iterable<string>, now = Date.now()): Map<string, { raw: unknown; at: number; read: PeerNotes }> {
  const out = new Map<string, { raw: unknown; at: number; read: PeerNotes }>();
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(text);
  } catch {
    return out;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const g of given) {
    if (!Object.hasOwn(saved, g)) continue;
    const raw = saved[g];
    const read = readPeerNotes(raw, g.split('#')[1] || undefined, now);
    if ('refused' in read) continue;
    out.set(g, { raw, at: (raw as { at: number }).at, read });
  }
  return out;
}

/** How many routers one router reads on its peers' word (--meet-peers), on top of the ones it was given. */
export const MEET_MAX = 8;

/** What a router serves at /orrery/peers when it shares notes: the routers it reads whose notes it could check, each
 * with the key that signed them, so a router that meets them through it can pin them to that key. */
export type Introductions = { peers: { url: string; by: string }[]; relay?: { port: number; open?: number } | null };

/** The relay port a peer says it runs (in its /orrery/peers), or null when it runs none or says nothing readable. */
export function readRelayPort(j: unknown): number | null {
  const port = (j as Partial<Introductions> | null)?.relay?.port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** How many connections a peer's relay says it has open now, or null when it does not say (or runs no relay). */
export function readRelayOpen(j: unknown): number | null {
  if (readRelayPort(j) === null) return null;
  const open = (j as Partial<Introductions> | null)?.relay?.open;
  return typeof open === 'number' && Number.isSafeInteger(open) && open >= 0 ? open : null;
}

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

/** How long to wait before reading a peer again after it missed so many reads in a row: nothing for the first three,
 * then a minute, doubling up to ten, so an address that is gone does not cost a timeout on every refresh. */
export function peerBackoffMs(missed: number): number {
  return missed < 3 ? 0 : Math.min(60_000 * 2 ** (missed - 3), 600_000);
}

/** How much the word of a router met through a peer (--meet-peers) counts next to a peer this router was given: half. */
export const MET_WEIGHT = 0.5;

/** Notes count in full for this long after their peer wrote them. */
export const NOTES_FRESH_MS = 600_000;

/** How much a peer's notes still count by their age: in full for NOTES_FRESH_MS, then less each minute, down to nothing
 * at NOTES_MAX_AGE_MS, when they are let go of anyway. A peer that went quiet half an hour ago, or notes picked up from
 * before a restart, steer a node's start less than notes written a minute ago. */
export function peerFreshness(ageMs: number): number {
  if (!(ageMs > NOTES_FRESH_MS)) return 1;
  if (ageMs >= NOTES_MAX_AGE_MS) return 0;
  return (NOTES_MAX_AGE_MS - ageMs) / (NOTES_MAX_AGE_MS - NOTES_FRESH_MS);
}

/** Where --trust-peers starts a node this router has never asked: what the peers saw it answer, each peer weighted by
 * how close it is (a peer this router was given counts in full, a router met through one at MET_WEIGHT) and by how
 * fresh its notes are (peerFreshness), and moved
 * away from the neutral guess only as far as the closest peer that saw it is trusted. A node only met routers saw
 * answer 0 of 40 starts at 0.3, halfway between 0.6 and 0; one a given peer saw do that starts at 0. Null when no
 * peer sent it anything. */
export function peerPrior(seen: { weight: number; sent: number; answered: number }[], neutral = 0.6): number | null {
  const used = seen.filter((s) => s.sent > 0 && s.weight > 0);
  if (!used.length) return null;
  const sent = used.reduce((t, s) => t + s.weight * s.sent, 0);
  const answered = used.reduce((t, s) => t + s.weight * s.answered, 0);
  const closest = Math.max(...used.map((s) => s.weight));
  return neutral + closest * (answered / sent - neutral);
}

/** The peers in a --peers-file: one router address a line (url, or url#<key> to pin it), optionally followed by a name
 * for it ("http://<host>:7171#<key> alice"), blank lines and lines starting with # left out, anything that is not an
 * http(s) address dropped. At most 64 are kept. */
export function parsePeersFile(text: string): string[] {
  return [...peersFileNames(text).keys()];
}

/** The same lines as address -> name (null when the line gives none). A name is at most 40 printable characters. */
export function peersFileNames(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [address, ...rest] = line.split(/\s+/);
    if (!/^https?:\/\/\S+$/.test(address) || out.has(address)) continue;
    const name = rest.join(' ').replace(/[^\x20-\x7e]/g, '').slice(0, 40).trim();
    out.set(address, name || null);
    if (out.size === 64) break;
  }
  return out;
}
