import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

/** A relay is a second, separate listener on a router: another router uses it as its proxy
 * (`orrery router --proxy http://<this router>:<relay port>`), so the nodes it pays see this router's address and not
 * its own. It speaks the two things an HTTP proxy is asked for, a tunnel (CONNECT) and a forwarded plain-http request,
 * and only to the addresses of nodes listed on chain: it is not an open proxy, and it never serves the router's own
 * API, so nothing that spends this router's wallet is reachable through it. What it carries to a node is already
 * sealed to that node's key, payment included for nodes that read it inside the seal: the relay sees a host and a
 * port, never a prompt. */
export type RelayOptions = { allowed: () => Set<string>; perClient?: () => number; clientAllowed?: (address: string) => boolean; maxBytes?: () => number; holder?: (proof: string) => Promise<boolean>; log?: (line: string) => void };

/** The header a router sends a peer's relay to show it holds $OREY: `<wallet>.<ms>.<signature>`, the wallet's signature
 * over HOLDER_PROOF, the relay router's key and the time. Never passed on to the node. */
export const HOLDER_HEADER = 'x-orrery-holder';

export function holderProofMessage(relayKey: string, ms: number): Uint8Array {
  return new TextEncoder().encode(`orrery-relay-holder|${relayKey}|${ms}`);
}

/** A byte count as people read it: 512 B, 3.4 KB, 12.0 MB, 1.25 GB. */
export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const DAY_MS = 86_400_000;

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

const HOP = new Set(['x-orrery-holder', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-forwarded-for', 'forwarded', 'via']);

/** A router that shows it holds $OREY gets this many times a relay's connections at a time. */
export const RELAY_HOLDER_FACTOR = 2;

export class Relay {
  relayed = 0;
  refused = 0;
  /** Bytes carried for other routers, both ways: what they sent the nodes and what came back. */
  bytes = 0;
  /** Connections carried for $OREY holders while the relay was full for today. */
  forHolders = 0;
  /** The bytes carried in the relay's current day, which starts with the first byte after the last day ended. */
  private day = { start: 0, bytes: 0 };
  /** The routers carried in the relay's current day, as a count: the addresses are kept in memory for the day only, to
   * count each once, and are never shown or written anywhere. */
  private routersDay = { start: 0, seen: new Set<string>() };
  readonly server: Server;
  /** Connections open through the relay right now, by the address they came from. */
  private readonly openBy = new Map<string, number>();

  constructor(private readonly o: RelayOptions) {
    this.server = createServer((req, res) => void this.forward(req, res));
    this.server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => void this.tunnel(req, socket, head));
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

  /** How many routers this relay carried at least one connection for in the last day. */
  get routersToday(): number {
    return Date.now() - this.routersDay.start >= DAY_MS ? 0 : this.routersDay.seen.size;
  }

  private carriedFor(from: string): void {
    const now = Date.now();
    if (now - this.routersDay.start >= DAY_MS) this.routersDay = { start: now, seen: new Set() };
    this.routersDay.seen.add(plainAddress(from));
  }

  /** Bytes carried in the current day. */
  get today(): number {
    return Date.now() - this.day.start >= DAY_MS ? 0 : this.day.bytes;
  }

  /** Past the day's limit, a connection still goes through when the router behind it shows it holds $OREY; the rest are
   * turned away with when the relay carries again. Null when it goes through. */
  private fullFor(holder: boolean): string | null {
    const full = this.fullLine();
    if (!full) return null;
    if (holder) {
      this.forHolders += 1;
      return null;
    }
    return full;
  }

  /** Whether the router behind a connection showed it holds $OREY (a wallet signature, checked on chain by the relay's
   * router). */
  private async holderOf(proof: string | string[] | undefined): Promise<boolean> {
    return typeof proof === 'string' && !!this.o.holder && (await this.o.holder(proof).catch(() => false));
  }

  /** Whether the relay has carried its limit for today and takes no new connections. */
  get full(): boolean {
    return this.fullLine() !== null;
  }

  /** How many bytes a day the relay carries before it turns new connections away; 0 for no limit. */
  get maxBytes(): number {
    return Math.max(0, Math.floor(this.o.maxBytes?.() ?? 0));
  }

  /** Hours until the relay's day turns, at least 1. */
  private hoursLeft(): number {
    return Math.max(1, Math.ceil((this.day.start + DAY_MS - Date.now()) / 3_600_000));
  }

  /** Counts bytes carried, and logs once, as the day's limit is reached, that new connections are turned away. */
  private count(n: number): void {
    this.bytes += n;
    const now = Date.now();
    if (now - this.day.start >= DAY_MS) this.day = { start: now, bytes: 0 };
    const was = this.day.bytes;
    this.day.bytes += n;
    const max = this.maxBytes;
    if (max && was < max && this.day.bytes >= max) this.o.log?.(`relay: carried its ${bytesText(max)} for today; new connections are turned away for about ${this.hoursLeft()} h, the ones open now finish`);
  }

  /** Why a new connection is turned away when the day's bytes are used up, or null while there is room. Connections
   * already open are carried to their end. */
  private fullLine(): string | null {
    const max = this.maxBytes;
    if (!max || this.today < max) return null;
    return `this relay has carried its ${bytesText(max)} for today; it carries again in about ${this.hoursLeft()} h`;
  }

  private busyLine(holder = false): string {
    const n = this.perClient * (holder ? RELAY_HOLDER_FACTOR : 1);
    return `this relay carries up to ${n} connection${n === 1 ? '' : 's'} at a time for one address${holder ? ' holding $OREY' : ''}; wait for one to finish`;
  }

  /** Takes one of an address's places on the relay, or null when it has none left. The place is given back once, when
   * the connection closes. */
  private take(from: string, holder = false): (() => void) | null {
    const n = this.openBy.get(from) ?? 0;
    if (n >= this.perClient * (holder ? RELAY_HOLDER_FACTOR : 1)) return null;
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
  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const holder = await this.holderOf(req.headers[HOLDER_HEADER]);
    const full = this.fullFor(holder);
    if (full) {
      this.refused += 1;
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relay_full', message: full } }));
      return;
    }
    const release = this.take(req.socket.remoteAddress ?? '?', holder);
    if (!release) {
      this.refused += 1;
      res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'relay_busy', message: this.busyLine(holder) } }));
      return;
    }
    res.on('close', release);
    req.on('data', (c: Buffer) => this.count(c.length));
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k.toLowerCase())));
    const up = httpRequest({ host: target.hostname, port: Number(target.port || 80), method: req.method, path: `${target.pathname}${target.search}`, headers, agent: false }, (r) => {
      this.relayed += 1;
      this.carriedFor(req.socket.remoteAddress ?? '?');
      const back = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !HOP.has(k.toLowerCase())));
      res.writeHead(r.statusCode ?? 502, back);
      r.on('data', (c: Buffer) => this.count(c.length));
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
  private async tunnel(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
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
    const holder = await this.holderOf(req.headers[HOLDER_HEADER]);
    const full = this.fullFor(holder);
    if (full) {
      this.refused += 1;
      socket.end(`HTTP/1.1 429 Too Many Requests\r\ncontent-type: text/plain\r\n\r\n${full}\n`);
      return;
    }
    const release = this.take(socket.remoteAddress ?? '?', holder);
    if (!release) {
      this.refused += 1;
      socket.end(`HTTP/1.1 429 Too Many Requests\r\ncontent-type: text/plain\r\n\r\n${this.busyLine(holder)}\n`);
      return;
    }
    socket.on('close', release);
    const far = netConnect(Number(m[2]), m[1], () => {
      this.relayed += 1;
      this.carriedFor(socket.remoteAddress ?? '?');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) far.write(head);
      this.count(head.length);
      far.on('data', (c: Buffer) => this.count(c.length));
      socket.on('data', (c: Buffer) => this.count(c.length));
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
