import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

/** A relay is a second, separate listener on a router: another router uses it as its proxy
 * (`orrery router --proxy http://<this router>:<relay port>`), so the nodes it pays see this router's address and not
 * its own. It speaks the two things an HTTP proxy is asked for, a tunnel (CONNECT) and a forwarded plain-http request,
 * and only to the addresses of nodes listed on chain: it is not an open proxy, and it never serves the router's own
 * API, so nothing that spends this router's wallet is reachable through it. What it carries to a node is already
 * sealed to that node's key, payment included for nodes that read it inside the seal: the relay sees a host and a
 * port, never a prompt. */
export type RelayOptions = { allowed: () => Set<string>; perClient?: () => number; clientAllowed?: (address: string) => boolean; log?: (line: string) => void };

/** An address as a relay compares it: an IPv4 address that came in as IPv6 (::ffff:10.0.0.2) is the IPv4 one. */
export function plainAddress(address: string): string {
  return address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').toLowerCase();
}

const PEERS_ONLY = 'this relay carries traffic only for its peer routers';

/** How many connections one address may have open through a relay at once, unless the router says otherwise: a relay
 * is shared, so no one address takes all of it. */
export const RELAY_PER_CLIENT = 16;

/** host:port as a relay keys it, with the default port when none is written. */
export function targetKey(hostname: string, port: string | number | undefined, protocol: 'http:' | 'https:'): string {
  return `${hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${Number(port || (protocol === 'https:' ? 443 : 80))}`;
}

/** The host:port of each node endpoint, as a relay allows them. */
export function allowedTargets(endpoints: string[]): Set<string> {
  const out = new Set<string>();
  for (const e of endpoints) {
    try {
      const u = new URL(e);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(targetKey(u.hostname, u.port, u.protocol));
    } catch {
      continue;
    }
  }
  return out;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-forwarded-for', 'forwarded', 'via']);

export class Relay {
  relayed = 0;
  refused = 0;
  readonly server: Server;
  /** Connections open through the relay right now, by the address they came from. */
  private readonly openBy = new Map<string, number>();

  constructor(private readonly o: RelayOptions) {
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => this.tunnel(req, socket, head));
  }

  /** Connections open through the relay right now, from every address. */
  get open(): number {
    let n = 0;
    for (const v of this.openBy.values()) n += v;
    return n;
  }

  /** How many connections one address may have open at once. */
  get perClient(): number {
    return Math.max(1, Math.floor(this.o.perClient?.() ?? RELAY_PER_CLIENT));
  }

  private busyLine(): string {
    return `this relay carries up to ${this.perClient} connection${this.perClient === 1 ? '' : 's'} at a time for one address; wait for one to finish`;
  }

  /** Takes one of an address's places on the relay, or null when it has none left. The place is given back once, when
   * the connection closes. */
  private take(from: string): (() => void) | null {
    const n = this.openBy.get(from) ?? 0;
    if (n >= this.perClient) return null;
    this.openBy.set(from, n + 1);
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const left = (this.openBy.get(from) ?? 1) - 1;
      if (left > 0) this.openBy.set(from, left);
      else this.openBy.delete(from);
    };
  }

  private refuse(res: ServerResponse, why: string): void {
    this.refused += 1;
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relay_refused', message: why } }));
  }

  /** A plain-http request in absolute form (the node's whole address in the request line, as a proxy is asked), passed
   * on to a listed node with nothing added that names the router it came from. */
  private forward(req: IncomingMessage, res: ServerResponse): void {
    if (this.o.clientAllowed && !this.o.clientAllowed(plainAddress(req.socket.remoteAddress ?? ''))) return this.refuse(res, PEERS_ONLY);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      return this.refuse(res, 'a relay only passes requests on to nodes listed on chain; this is not a request for one');
    }
    if (target.protocol !== 'http:' || !this.o.allowed().has(targetKey(target.hostname, target.port, 'http:'))) {
      return this.refuse(res, `a relay only passes requests on to nodes listed on chain; ${target.host || 'this address'} is not one`);
    }
    const release = this.take(req.socket.remoteAddress ?? '?');
    if (!release) {
      this.refused += 1;
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relay_busy', message: this.busyLine() } }));
      return;
    }
    res.on('close', release);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k.toLowerCase())));
    const up = httpRequest({ host: target.hostname, port: Number(target.port || 80), method: req.method, path: `${target.pathname}${target.search}`, headers, agent: false }, (r) => {
      this.relayed += 1;
      const back = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.has(k.toLowerCase())));
      res.writeHead(r.statusCode ?? 502, back);
      r.pipe(res);
    });
    up.setTimeout(120_000, () => up.destroy(new Error('the node sent nothing for 120 seconds')));
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relay_upstream', message: `the node did not answer the relay: ${e.message}` } }));
      else res.destroy();
    });
    req.pipe(up);
  }

  /** CONNECT host:port: a tunnel to a listed node, for an https endpoint (TLS runs inside it, end to end). */
  private tunnel(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.o.clientAllowed && !this.o.clientAllowed(plainAddress(socket.remoteAddress ?? ''))) {
      this.refused += 1;
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${PEERS_ONLY}\n`);
      return;
    }
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    if (!m || !this.o.allowed().has(targetKey(m[1], m[2], 'https:'))) {
      this.refused += 1;
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\na relay only opens tunnels to nodes listed on chain\n');
      return;
    }
    const release = this.take(socket.remoteAddress ?? '?');
    if (!release) {
      this.refused += 1;
      socket.end(`HTTP/1.1 429 Too Many Requests\r\ncontent-type: text/plain\r\n\r\n${this.busyLine()}\n`);
      return;
    }
    socket.on('close', release);
    const far = netConnect(Number(m[2]), m[1], () => {
      this.relayed += 1;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) far.write(head);
      far.pipe(socket);
      socket.pipe(far);
    });
    const close = () => {
      far.destroy();
      socket.destroy();
    };
    far.on('error', () => {
      if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    socket.on('error', close);
  }
}
