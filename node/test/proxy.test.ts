import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchNode, nodeProxy, parseProxy, proxyAnswers, setNodeProxy, viaProxy } from '../src/proxy.ts';

const SECRET = 'the-prompt-nobody-in-the-middle-should-read';
const portOf = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));

// A node stand-in: says what it was asked, streams when asked to, and can hang.
const seen: { method: string; url: string; body: string; headers: Record<string, unknown> }[] = [];
const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
    if (req.url === '/hang') return;
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.end('data: two\n\n'), 30);
      return;
    }
    if (req.url === '/empty') return void res.writeHead(204).end();
    res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json', 'x-node': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, got: body.length }));
  });
};

// A proxy stand-in that records what it could read: forwarded requests whole, tunnels as a destination and raw bytes.
const forwarded: { url: string; body: string; auth: string | undefined }[] = [];
const tunnels: { to: string; bytes: Buffer[] }[] = [];
let refuseTunnels = false;
const proxyServer = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    forwarded.push({ url: req.url ?? '', body, auth: req.headers['proxy-authorization'] as string | undefined });
    const u = new URL(req.url ?? '');
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const out = request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    out.on('error', () => res.writeHead(502).end());
    out.end(body);
  });
});
proxyServer.on('connect', (req, client) => {
  if (refuseTunnels) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const [host, port] = (req.url ?? '').split(':');
  const t = { to: req.url ?? '', bytes: [] as Buffer[] };
  tunnels.push(t);
  const up = connect(Number(port), host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    client.on('data', (d) => t.bytes.push(d));
    client.pipe(up);
    up.pipe(client);
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
});

const plain = createServer(handler);
let secure: Server | null = null;
let ca: Buffer | null = null;

before(async () => {
  await listen(plain);
  await listen(proxyServer);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-proxy-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'c.pem'));
    secure = createTlsServer({ key: readFileSync(join(dir, 'k.pem')), cert: ca }, handler);
    await new Promise<void>((r) => secure!.listen(0, '127.0.0.1', () => r()));
  } catch {
    secure = null;
  }
});
after(() => {
  setNodeProxy(null);
  plain.close();
  proxyServer.close();
  secure?.close();
  plain.closeAllConnections();
  proxyServer.closeAllConnections();
  secure?.closeAllConnections();
});

describe('reaching nodes through a proxy', () => {
  it('reads a proxy address and never prints its password', () => {
    assert.deepEqual(parseProxy('http://127.0.0.1:8118'), { host: '127.0.0.1', port: 8118, auth: null, label: '127.0.0.1:8118' });
    assert.deepEqual(parseProxy('proxy.example:3128'), { host: 'proxy.example', port: 3128, auth: null, label: 'proxy.example:3128' });
    const withAuth = parseProxy('http://me:s3cret%21@proxy.example:3128');
    assert.equal(withAuth.auth, Buffer.from('me:s3cret!').toString('base64'));
    assert.ok(!withAuth.label.includes('s3cret') && !withAuth.label.includes('me'));
    assert.equal(parseProxy('http://proxy.example').port, 80);
    assert.throws(() => parseProxy('socks5://127.0.0.1:9050'), /HTTP proxy.*socks5 is not spoken/);
    assert.throws(() => parseProxy('https://proxy.example:443'), /https is not spoken/);
    assert.throws(() => parseProxy('http://'), /address like/);
  });

  it('a request to a plain-http node is forwarded by the proxy and answered as a fetch Response', async () => {
    const proxy = parseProxy(`http://user:pw@127.0.0.1:${portOf(proxyServer)}`);
    const before = forwarded.length;
    const r = await viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/v1/chat/completions?x=1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-wire': '1' }, body: JSON.stringify({ sealed: 'abc' }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-node'), 'yes');
    assert.deepEqual(await r.json(), { method: 'POST', url: '/v1/chat/completions?x=1', got: 16 });
    assert.equal(forwarded.length, before + 1);
    assert.equal(forwarded.at(-1)!.url, `http://127.0.0.1:${portOf(plain)}/v1/chat/completions?x=1`);
    assert.equal(forwarded.at(-1)!.auth, `Basic ${Buffer.from('user:pw').toString('base64')}`);
    const node = seen.at(-1)!;
    assert.equal(node.headers['x-orrery-wire'], '1');
    assert.equal(node.headers['proxy-authorization'], undefined);
    const missing = await viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/missing`);
    assert.equal(missing.status, 404);
    const empty = await viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/empty`);
    assert.equal(empty.status, 204);
    assert.equal(empty.body, null);
  });

  it('a stream arrives as it is sent', async () => {
    const r = await viaProxy(parseProxy(`127.0.0.1:${portOf(proxyServer)}`), `http://127.0.0.1:${portOf(plain)}/stream`);
    assert.equal(await r.text(), 'data: one\n\ndata: two\n\n');
  });

  it('an https node is reached by a tunnel: the proxy sees where, and none of what', async (t) => {
    if (!secure || !ca) return t.skip('openssl is not here to make a certificate');
    const proxy = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    const before = tunnels.length;
    const r = await viaProxy(proxy, `https://localhost:${portOf(secure)}/v1/chat/completions`, { method: 'POST', body: SECRET }, { ca });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { method: 'POST', url: '/v1/chat/completions', got: SECRET.length });
    assert.equal(tunnels.length, before + 1);
    assert.equal(tunnels.at(-1)!.to, `localhost:${portOf(secure)}`);
    const carried = Buffer.concat(tunnels.at(-1)!.bytes);
    assert.ok(carried.length > SECRET.length);
    assert.ok(!carried.includes(SECRET) && !carried.includes('/v1/chat/completions'));
    assert.equal(seen.at(-1)!.body, SECRET);
    // The node's certificate is checked through the tunnel: without the test authority this one is refused.
    await assert.rejects(viaProxy(proxy, `https://localhost:${portOf(secure)}/v1/models`), /TLS to localhost through the proxy/);
  });

  it('a proxy that refuses the tunnel is an error that names it', async (t) => {
    if (!secure || !ca) return t.skip('openssl is not here to make a certificate');
    refuseTunnels = true;
    try {
      await assert.rejects(viaProxy(parseProxy(`127.0.0.1:${portOf(proxyServer)}`), `https://localhost:${portOf(secure)}/v1/models`, {}, { ca }), /refused a tunnel to localhost:\d+ \(403\)/);
    } finally {
      refuseTunnels = false;
    }
  });

  it('with a proxy set and nothing answering there, the request fails and the node hears nothing', async () => {
    const dead = createServer();
    await listen(dead);
    const port = portOf(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    const proxy = parseProxy(`127.0.0.1:${port}`);
    assert.equal(await proxyAnswers(proxy, 500), false);
    assert.equal(await proxyAnswers(parseProxy(`127.0.0.1:${portOf(proxyServer)}`), 500), true);
    setNodeProxy(proxy);
    try {
      assert.equal(nodeProxy()?.label, `127.0.0.1:${port}`);
      const heard = seen.length;
      await assert.rejects(fetchNode(`http://127.0.0.1:${portOf(plain)}/v1/models`), /through the proxy at 127\.0\.0\.1:\d+/);
      assert.equal(seen.length, heard);
    } finally {
      setNodeProxy(null);
    }
    const direct = await fetchNode(`http://127.0.0.1:${portOf(plain)}/v1/models`);
    assert.equal(direct.status, 200);
  });

  it('keeps the timing rules of a direct request: a timeout until the headers, or the caller’s own signal', async () => {
    const proxy = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    await assert.rejects(viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/hang`, { timeoutMs: 120 }), /timeout after 120ms/);
    const ctl = new AbortController();
    const pending = viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/hang`, { signal: ctl.signal, timeoutMs: 50 });
    setTimeout(() => ctl.abort(new Error('the client went away')), 150);
    await assert.rejects(pending, /the client went away/);
    const gone = new AbortController();
    gone.abort(new Error('already gone'));
    await assert.rejects(viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/v1/models`, { signal: gone.signal }), /already gone/);
  });

  it('nothing in the router reaches a node any other way', () => {
    const dir = new URL('../src/router/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      assert.ok(!src.includes('fetchWithTimeout('), `${f} calls fetchWithTimeout; requests to nodes go through fetchNode`);
      assert.ok(!/[^a-zA-Z.'`]fetch\(`\$\{/.test(src), `${f} calls fetch on a built address; requests to nodes go through fetchNode`);
    }
  });
});
