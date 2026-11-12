// Reaching nodes through a proxy, so a node sees the proxy's address and not yours.
//
// A node learns three things about whoever asks: the wallet that pays it, the request, and the address the request
// came from. The first is a keypair of your choosing, the second can be sealed to an enclave, and this file is for the
// third. Requests to nodes are already encrypted to each node's own key, so the proxy in the middle carries
// ciphertext: it learns which node you talk to, when, and how much, and nothing of what was said.
//
// Two kinds of proxy are spoken: HTTP (CONNECT for https, a forwarded request for http) and SOCKS5 (a tunnel for
// either; the proxy is given the name, so it does the lookup). The Solana RPC and the chip makers' certificate lists
// go the same way (outFetch, chain/connect.ts), so with a proxy set this process opens no connection to anything
// else. A node operator's own model server is not covered: that is the node's side.
//
// There is no fallback. When a proxy is set and it does not answer, the request fails; it never goes out directly.
import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { Readable, type Duplex } from 'node:stream';
import { fetchWithTimeout } from './sse.ts';

export type Proxy = { kind: 'http' | 'socks5'; host: string; port: number; auth: string | null; user: string | null; pass: string | null; label: string };
type Init = RequestInit & { timeoutMs?: number };

/** Reads `http://host:port`, `socks5://host:port` (or `host:port`, or with `user:pass@`). The label is what gets
 * printed: never the password. */
export function parseProxy(text: string): Proxy {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`--proxy is an address like http://127.0.0.1:8118 or socks5://127.0.0.1:9050, not "${text}"`);
  }
  const kind = u.protocol === 'http:' ? 'http' : u.protocol === 'socks5:' || u.protocol === 'socks5h:' ? 'socks5' : null;
  if (!kind) throw new Error(`--proxy speaks HTTP (http://host:port) and SOCKS5 (socks5://host:port); ${u.protocol.replace(':', '')} is not spoken here`);
  if (!u.hostname) throw new Error('--proxy needs a host');
  const port = Number(u.port || (kind === 'http' ? 80 : 1080));
  const user = u.username ? decodeURIComponent(u.username) : null, pass = u.username ? decodeURIComponent(u.password) : null;
  const auth = user !== null ? Buffer.from(`${user}:${pass}`).toString('base64') : null;
  return { kind, host: u.hostname.replace(/^\[|\]$/g, ''), port, auth, user, pass, label: `${u.hostname}:${port}` };
}

/** The 16 bytes of an IPv6 address written as text (brackets, a zone and an IPv4 tail allowed), as SOCKS5 sends it. */
export function ipv6Bytes(text: string): Buffer {
  let s = text.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const four = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (four) {
    const [a, b, c, d] = four.slice(1).map(Number);
    s = `${s.slice(0, four.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [], tail = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (halves.length > 2 || groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) throw new Error(`${text} is not an IPv6 address`);
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/** host:port as a proxy and a Host header expect it: an IPv6 address in brackets. */
const authority = (host: string, port: number) => (isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`);

const SOCKS_SAID: Record<number, string> = { 1: 'general failure', 2: 'not allowed by its rules', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'timed out', 7: 'command not supported', 8: 'address type not supported' };

/** Asks a SOCKS5 proxy (RFC 1928, with RFC 1929 name and password when given) for a tunnel to host:port. The proxy
 * is sent the name itself, so the lookup happens there and not on this machine. */
export function socksTunnel(proxy: Proxy, host: string, port: number, onSocket?: (s: Socket) => void): Promise<Socket> {
  return new Promise((done, fail) => {
    const s = netConnect({ host: proxy.host, port: proxy.port });
    onSocket?.(s);
    const bad = (m: string) => {
      s.destroy();
      fail(new Error(m));
    };
    // Exactly n bytes, read without switching the socket to flowing mode, so whatever follows the handshake is left
    // in place for TLS or HTTP to read.
    const read = (n: number) => new Promise<Buffer>((got, lost) => {
      const attempt = () => {
        const b = s.read(n) as Buffer | null;
        if (!b) return;
        s.off('readable', attempt);
        if (b.length < n) lost(new Error('closed the connection early'));
        else got(b);
      };
      s.on('readable', attempt);
      attempt();
    });
    const gone = () => fail(new Error(`the proxy at ${proxy.label} closed the connection`));
    s.once('error', (e) => fail(new Error(`the proxy at ${proxy.label} did not answer: ${e.message}`)));
    s.once('close', gone);
    s.once('connect', () => {
      void (async () => {
        const named = proxy.user !== null;
        s.write(Buffer.from(named ? [5, 2, 0, 2] : [5, 1, 0]));
        const [version, method] = await read(2);
        if (version !== 5) return bad(`${proxy.label} does not speak SOCKS5`);
        if (method === 2) {
          const u = Buffer.from(proxy.user ?? ''), p = Buffer.from(proxy.pass ?? '');
          if (!named || !u.length || u.length > 255 || p.length > 255) return bad(`the proxy at ${proxy.label} wants a name and password (socks5://name:password@host:port)`);
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          if ((await read(2))[1] !== 0) return bad(`the proxy at ${proxy.label} did not accept the name and password`);
        } else if (method !== 0) return bad(`the proxy at ${proxy.label} accepts no way of signing in that this router has`);
        // An address goes as itself (IPv4: 1, IPv6: 4); a name goes as the name (3), so the proxy does the lookup.
        const v = isIP(host), name = Buffer.from(host);
        if (!v && name.length > 255) return bad('that host name is too long for SOCKS');
        const address = v === 4 ? Buffer.from([1, ...host.split('.').map(Number)]) : v === 6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]) : Buffer.concat([Buffer.from([3, name.length]), name]);
        s.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]));
        const reply = await read(4);
        if (reply[0] !== 5) return bad(`${proxy.label} does not speak SOCKS5`);
        if (reply[1] !== 0) return bad(`the proxy at ${proxy.label} could not reach ${authority(host, port)} (${SOCKS_SAID[reply[1]] ?? `code ${reply[1]}`})`);
        const bound = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await read(1))[0] : -1;
        if (bound < 0) return bad(`${proxy.label} answered in a way SOCKS5 does not`);
        await read(bound + 2);
        s.off('close', gone);
        done(s);
      })().catch((e: Error) => bad(`the proxy at ${proxy.label} ${e.message}`));
    });
  });
}

/** Asks an HTTP proxy for a tunnel (CONNECT) to host:port. The proxy resolves the name. */
export function httpTunnel(proxy: Proxy, host: string, port: number): Promise<Socket> {
  return new Promise((done, fail) => {
    const ask = httpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority(host, port), agent: false, headers: { host: authority(host, port), ...(proxy.auth ? { 'proxy-authorization': `Basic ${proxy.auth}` } : {}) } });
    ask.on('error', (err) => fail(new Error(`the proxy at ${proxy.label} did not answer: ${err.message}`)));
    ask.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`the proxy at ${proxy.label} refused a tunnel to ${authority(host, port)} (${res.statusCode})`));
      }
      done(socket as Socket);
    });
    ask.end();
  });
}

/** A tunnel that carries nothing for this long is closed, whether it is waiting for its next request or holding an
 * answer nobody is reading. */
const QUIET_MS = 120_000;

/** Keeps tunnels open between requests: the next request to the same host rides the one already there instead of
 * paying for a new connection, a new tunnel and a new TLS handshake. One request at a time on each. */
class TunnelAgent extends Agent {
  constructor(private open: (host: string, port: number) => Promise<Duplex>) {
    super({ keepAlive: true, maxFreeSockets: 8 });
  }

  override createConnection(options: { host?: string | null; port?: number | string | null }, done?: (err: Error | null, stream: Duplex) => void): Duplex {
    this.open(String(options.host), Number(options.port)).then(
      (stream) => {
        (stream as Socket).setTimeout?.(QUIET_MS);
        done?.(null, stream);
      },
      (err: Error) => done?.(err, undefined as never),
    );
    return undefined as never;
  }
}

type Pool = { secure: Agent; plain: Agent; forward: Agent };
const NO_TLS: ConnectionOptions = {};
const pools = new Map<string, { tls: ConnectionOptions; pool: Pool }>();
const closePool = (p: Pool) => [p.secure, p.plain, p.forward].forEach((a) => a.destroy());

/** The kept tunnels for one proxy. A different set of TLS options gets its own tunnels: one opened under looser
 * rules is never handed to a request that asked for stricter ones. */
function poolFor(proxy: Proxy, tls: ConnectionOptions): Pool {
  const key = `${proxy.kind}|${proxy.host}|${proxy.port}|${proxy.auth ?? ''}`;
  const have = pools.get(key);
  if (have && have.tls === tls) return have.pool;
  if (have) closePool(have.pool);
  const tunnel = (host: string, port: number) => (proxy.kind === 'socks5' ? socksTunnel(proxy, host, port) : httpTunnel(proxy, host, port));
  const pool: Pool = {
    // An https host: TLS to the host itself inside the tunnel, checked before the first request is written.
    secure: new TunnelAgent(async (host, port) => {
      const socket = await tunnel(host, port);
      return await new Promise<Duplex>((done, fail) => {
        const secure = tlsConnect({ ...tls, socket, ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ['http/1.1'] });
        const bad = (err: Error) => {
          secure.destroy();
          fail(new Error(`TLS to ${host} through the proxy: ${err.message}`));
        };
        secure.once('error', bad);
        secure.once('secureConnect', () => {
          secure.off('error', bad);
          done(secure);
        });
      });
    }),
    // A plain-http host through SOCKS5: the tunnel itself.
    plain: new TunnelAgent(tunnel),
    // A plain-http host through an HTTP proxy: the proxy is asked for the whole address, over a kept connection to it.
    forward: new Agent({ keepAlive: true, maxFreeSockets: 8, timeout: QUIET_MS }),
  };
  pools.set(key, { tls, pool });
  return pool;
}

let current: Proxy | null = null;
let testTls: ConnectionOptions = NO_TLS;

/** Sets (or clears) the proxy every request to a node goes through, for this process. */
export function setNodeProxy(p: Proxy | null, tls: ConnectionOptions = NO_TLS): void {
  // Tunnels kept for the proxy being left are closed, so nothing rides an old route after a change.
  for (const { pool } of pools.values()) closePool(pool);
  pools.clear();
  current = p;
  testTls = tls;
}

export function nodeProxy(): Proxy | null {
  return current;
}

/** Every request this software makes to a node goes through here: by the proxy when one is set, directly when not. */
export function fetchNode(url: string, init: Init = {}): Promise<Response> {
  return current ? viaProxy(current, url, init, testTls) : fetchWithTimeout(url, init);
}

/** A drop-in `fetch` for everything else this software asks for (the Solana RPC, the chip makers' certificates and
 * lists, the package registry): through the proxy when one is set, plain fetch when not. */
export const outFetch: typeof fetch = (input, init) => {
  if (!current) return fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return viaProxy(current, url, { timeoutMs: 30_000, ...(init ?? {}) } as Init, testTls);
};

/** Whether anything accepts a connection at the proxy's address. */
export function proxyAnswers(p: Proxy, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((done) => {
    const s = netConnect({ host: p.host, port: p.port });
    const end = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

function bodyOf(body: Init['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error('a request through the proxy carries a string or bytes');
}

/** One request through the proxy, answered as a fetch Response. Same timing rule as fetchWithTimeout: the timeout
 * covers the time until the answer's headers, and a caller's own signal replaces it. */
export function viaProxy(proxy: Proxy, url: string, init: Init = {}, tls: ConnectionOptions = NO_TLS): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return Promise.reject(new Error(`cannot reach ${target.protocol} through the proxy`));
  const method = (init.method ?? 'GET').toUpperCase();
  let body: Buffer | null;
  try {
    body = bodyOf(init.body);
  } catch (err) {
    return Promise.reject(err);
  }
  const headers: Record<string, string> = { 'user-agent': 'node', accept: '*/*' };
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  if (body) headers['content-length'] = String(body.length);
  const ctl = new AbortController();
  const signal = init.signal ?? ctl.signal;
  const timeoutMs = init.timeoutMs ?? 10_000;
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const why = (): Error => (signal.reason instanceof Error ? signal.reason : new Error('aborted'));

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let live: { destroy(err?: Error): unknown } | null = null;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };
    const onAbort = () => {
      const err = why();
      live?.destroy(err);
      fail(err);
    };
    if (signal.aborted) return void onAbort();
    signal.addEventListener('abort', onAbort, { once: true });

    const send = (opts: RequestOptions, again = false) => {
      const req: ClientRequest = httpRequest({ ...opts, method, headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) } }, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          return fail(new Error(`unexpected status ${status} through the proxy`));
        }
        settled = true;
        clearTimeout(timer);
        live = res;
        res.once('close', () => signal.removeEventListener('abort', onAbort));
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, one);
        const empty = method === 'HEAD' || status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: out }));
      });
      live = req;
      req.on('error', (err) => {
        // A tunnel kept from an earlier request may have been closed at the far end since. That is not this request's
        // failure: it gets one fresh tunnel.
        if (req.reusedSocket && !again && !settled && !signal.aborted) return send(opts, true);
        fail(/the proxy at |through the proxy|SOCKS/.test(err.message) ? err : new Error(`through the proxy at ${proxy.label}: ${err.message}`));
      });
      req.on('timeout', () => req.destroy(new Error(`through the proxy at ${proxy.label}: nothing arrived for ${QUIET_MS / 1000} seconds`)));
      req.end(body ?? undefined);
    };

    const pool = poolFor(proxy, tls);
    const path = `${target.pathname}${target.search}`;
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    if (target.protocol === 'https:') {
      // An https host: a tunnel through the proxy (CONNECT, or SOCKS5), and TLS to the host itself inside it. The proxy
      // resolves the name, so this machine does not look the host up itself.
      send({ agent: pool.secure, host: hostname, port: Number(target.port || 443), path, headers: { host: target.host } });
    } else if (proxy.kind === 'socks5') {
      send({ agent: pool.plain, host: hostname, port: Number(target.port || 80), path, headers: { host: target.host } });
    } else {
      // A plain-http host through an HTTP proxy: the proxy is asked for the whole address. What it forwards is already
      // sealed to the node.
      send({ agent: pool.forward, host: proxy.host, port: proxy.port, path: target.href, headers: { host: target.host, ...(proxy.auth ? { 'proxy-authorization': `Basic ${proxy.auth}` } : {}) } });
    }
  });
}
