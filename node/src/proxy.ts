// Reaching nodes through a proxy, so a node sees the proxy's address and not yours.
//
// A node learns three things about whoever asks: the wallet that pays it, the request, and the address the request
// came from. The first is a keypair of your choosing, the second can be sealed to an enclave, and this file is for the
// third. Requests to nodes are already encrypted to each node's own key, so the proxy in the middle carries
// ciphertext: it learns which node you talk to, when, and how much, and nothing of what was said.
//
// Only an HTTP proxy is spoken (CONNECT for https, a forwarded request for http); no SOCKS. The Solana RPC and the
// chip makers' certificate lists go the same way (outFetch, chain/connect.ts), so with a proxy set this process
// opens no connection to anything else. A node operator's own model server is not covered: that is the node's side.
//
// There is no fallback. When a proxy is set and it does not answer, the request fails; it never goes out directly.
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { Readable } from 'node:stream';
import { fetchWithTimeout } from './sse.ts';

export type Proxy = { host: string; port: number; auth: string | null; label: string };
type Init = RequestInit & { timeoutMs?: number };

/** Reads `http://host:port` (or `host:port`, or with `user:pass@`). The label is what gets printed: never the password. */
export function parseProxy(text: string): Proxy {
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error(`--proxy is an address like http://127.0.0.1:8118, not "${text}"`);
  }
  if (u.protocol !== 'http:') throw new Error(`--proxy speaks to an HTTP proxy (http://host:port); ${u.protocol.replace(':', '')} is not spoken here`);
  if (!u.hostname) throw new Error('--proxy needs a host');
  const port = Number(u.port || 80);
  const auth = u.username ? Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') : null;
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port, auth, label: `${u.hostname}:${port}` };
}

let current: Proxy | null = null;
let testTls: ConnectionOptions = {};

/** Sets (or clears) the proxy every request to a node goes through, for this process. */
export function setNodeProxy(p: Proxy | null, tls: ConnectionOptions = {}): void {
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
export function viaProxy(proxy: Proxy, url: string, init: Init = {}, tls: ConnectionOptions = {}): Promise<Response> {
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

    const send = (opts: RequestOptions) => {
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
      req.on('error', (err) => fail(new Error(`through the proxy at ${proxy.label}: ${err.message}`)));
      req.end(body ?? undefined);
    };

    const proxyAuth: Record<string, string> = proxy.auth ? { 'proxy-authorization': `Basic ${proxy.auth}` } : {};
    if (target.protocol === 'http:') {
      // A plain-http node: the proxy is asked for the whole address. What it forwards is already sealed to the node.
      send({ host: proxy.host, port: proxy.port, path: target.href, agent: false, headers: { host: target.host, ...proxyAuth } });
      return;
    }
    // An https node: ask the proxy for a tunnel to it, then speak TLS to the node itself through that tunnel. The
    // proxy resolves the name, so this machine does not look the node up itself.
    const port = Number(target.port || 443);
    const tunnel = httpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${target.hostname}:${port}`, agent: false, headers: { host: `${target.hostname}:${port}`, ...proxyAuth } });
    live = tunnel;
    tunnel.on('error', (err) => fail(new Error(`the proxy at ${proxy.label} did not answer: ${err.message}`)));
    tunnel.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`the proxy at ${proxy.label} refused a tunnel to ${target.hostname}:${port} (${res.statusCode})`));
      }
      const secure = tlsConnect({ ...tls, socket, ...(isIP(target.hostname) ? {} : { servername: target.hostname }), ALPNProtocols: ['http/1.1'] });
      live = secure;
      secure.on('error', (err) => fail(new Error(`TLS to ${target.hostname} through the proxy: ${err.message}`)));
      send({ createConnection: () => secure, host: target.hostname, port, path: `${target.pathname}${target.search}`, headers: { host: target.host } });
    });
    tunnel.end();
  });
}
