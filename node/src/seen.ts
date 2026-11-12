// What a node can tell about where a request came from, and how a router reads that answer. A router that reaches
// nodes through a proxy can check it from the far side: it asks a node what it saw instead of trusting its own flag.
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fetchNode, type Proxy } from './proxy.ts';

/** `socket` is the other end of the connection the node accepted. `forwarded` is what a balancer or a forwarding proxy
 * on the way wrote into X-Forwarded-For, oldest first. `address` is the earliest address of all of them: the one a
 * node operator's log would call the caller. */
export type Seen = { address: string; socket: string; forwarded: string[] };

const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;
const plain = (a: string) => a.trim().replace(/^\[(.*)\]$/, '$1').replace(/^::ffff:/i, '');

const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) NOT_PUBLIC.addSubnet(net, bits, 'ipv6');

/** Whether an address is one the internet routes to: not loopback, not a private, shared or link-local range. */
export function isPublic(a: string): boolean {
  const v = isIP(a);
  return v !== 0 && !NOT_PUBLIC.check(a, v === 6 ? 'ipv6' : 'ipv4');
}

/** What this request tells the node about its origin. Only things shaped like an address are kept. Once any of them
 * is public, the private ones are left out: they are the hops of the network in front of the node (a hosting
 * balancer), or of the caller's own network, and say nothing a caller across the internet can use. When all of them
 * are private (a test on one machine or one network), they are said as they are. */
export function seenFrom(req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } }): Seen {
  let socket = plain(req.socket.remoteAddress ?? '');
  let forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(plain).filter((a) => ADDRESS.test(a)).slice(0, 8);
  if ([socket, ...forwarded].some(isPublic)) {
    forwarded = forwarded.filter(isPublic);
    if (!isPublic(socket)) socket = '';
  }
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

/** Asks nodes in turn what address they see and returns the first answer. It goes through the proxy when one is set. */
export async function askSeen(nodes: { name: string; endpoint: string }[], tries = 3, timeoutMs = 4_000): Promise<{ name: string; seen: Seen } | null> {
  for (const node of nodes.slice(0, tries)) {
    const seen = readSeen(await fetchNode(`${node.endpoint.replace(/\/$/, '')}/v1/seen`, { timeoutMs }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    if (seen) return { name: node.name, seen };
  }
  return null;
}

/** What a node saw of this computer, in one sentence. ok is false only when a proxy is set and an address the node saw
 * is one of this computer's own; an address that cannot be placed is given for the reader to compare. */
export function seenSays(name: string | null, seen: Seen | null, proxy: Proxy | null, own: string[]): { ok: boolean | null; detail: string } {
  if (!name || !seen) return { ok: null, detail: 'no node here answers GET /v1/seen, so none could say what address it sees (older nodes do not)' };
  const all = seenAddresses(seen);
  const rest = all.filter((a) => a !== seen.address);
  const also = rest.length ? ` (also in what reached it: ${rest.join(', ')})` : '';
  if (!proxy) return { ok: null, detail: `${name} sees ${seen.address}${also}; no proxy is set, so that is the address this computer's requests leave from (--proxy hides it)` };
  const mine = all.find((a) => own.includes(a));
  if (mine && seen.socket !== mine) return { ok: false, detail: `${name} sees ${mine}, which is this computer's own address: the proxy at ${proxy.label} passes it on in a header. A SOCKS5 proxy cannot add one` };
  if (mine) return { ok: false, detail: `${name} sees ${mine}, which is this computer's own address: the proxy at ${proxy.label} sends from this computer, so it hides nothing` };
  if (seen.address === proxy.host && !rest.length) return { ok: true, detail: `${name} sees ${seen.address}, the address of the proxy at ${proxy.label}` };
  return { ok: null, detail: `${name} sees ${seen.address}${also}, through the proxy at ${proxy.label}; if that is not your own address, nodes do not learn yours` };
}

/** The one case a router does not send in: a proxy is set, and a node saw an address that is this computer's own and
 * that the internet routes to. A private address is left to the line above: two networks can use the same one. */
export function givenAway(seen: Seen, own: string[], counts: (a: string) => boolean = isPublic): string | null {
  return seenAddresses(seen).find((a) => own.includes(a) && counts(a)) ?? null;
}
