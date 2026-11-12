// What a node can tell about where a request came from, and how a router reads that answer. A router that reaches
// nodes through a proxy can check it from the far side: it asks a node what it saw instead of trusting its own flag.
import type { IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';

/** `socket` is the other end of the connection the node accepted. `forwarded` is what a balancer or a forwarding proxy
 * on the way wrote into X-Forwarded-For, oldest first. `address` is the earliest address of all of them: the one a
 * node operator's log would call the caller. */
export type Seen = { address: string; socket: string; forwarded: string[] };

const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;
const plain = (a: string) => a.trim().replace(/^\[(.*)\]$/, '$1').replace(/^::ffff:/i, '');

/** What this request tells the node about its origin. Only things shaped like an address are kept. */
export function seenFrom(req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } }): Seen {
  const socket = plain(req.socket.remoteAddress ?? '');
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(plain).filter((a) => ADDRESS.test(a)).slice(0, 8);
  return { address: forwarded[0] ?? socket, socket, forwarded };
}

/** A node's answer to GET /v1/seen, or null when it is not one. The node is not trusted: whatever is printed later is
 * an address or nothing. */
export function readSeen(j: unknown): Seen | null {
  const s = j as Partial<Seen> | null;
  if (!s || typeof s.address !== 'string' || typeof s.socket !== 'string' || !Array.isArray(s.forwarded)) return null;
  const forwarded = s.forwarded.filter((a): a is string => typeof a === 'string').map(plain).filter((a) => ADDRESS.test(a)).slice(0, 8);
  const address = plain(s.address), socket = plain(s.socket);
  if (!ADDRESS.test(address)) return null;
  return { address, socket: ADDRESS.test(socket) ? socket : '', forwarded };
}

/** Every address in what the node saw, the caller's first, each once. */
export function seenAddresses(s: Seen): string[] {
  return [...new Set([s.address, ...s.forwarded, s.socket].filter(Boolean))];
}

/** The addresses of this computer's own network interfaces, loopback left out. */
export function ownAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => list ?? []).filter((i) => !i.internal).map((i) => plain(i.address.replace(/%.*$/, '')));
}
