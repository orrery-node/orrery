import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchNode, httpTunnel, ipv6Bytes, nodeProxy, parseProxy, proxyAnswers, setNodeProxy, socksTunnel, viaProxy } from '../src/proxy.ts';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { Keypair, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import { NO_WEBSOCKET, rpcConnection } from '../src/chain/connect.ts';
import { pollStatus, sendOne } from '../src/chain/send.ts';

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
let proxyConnections = 0;
proxyServer.on('connection', () => proxyConnections++);
proxyServer.on('connect', (req, client) => {
  if (refuseTunnels) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const m = /^\[?([^\]]*?)\]?:(\d+)$/.exec(req.url ?? '');
  const [host, port] = m ? [m[1], m[2]] : ['', '0'];
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
    assert.deepEqual(parseProxy('http://127.0.0.1:8118'), { kind: 'http', host: '127.0.0.1', port: 8118, auth: null, user: null, pass: null, label: '127.0.0.1:8118' });
    assert.deepEqual(parseProxy('proxy.example:3128'), { kind: 'http', host: 'proxy.example', port: 3128, auth: null, user: null, pass: null, label: 'proxy.example:3128' });
    const withAuth = parseProxy('http://me:s3cret%21@proxy.example:3128');
    assert.equal(withAuth.auth, Buffer.from('me:s3cret!').toString('base64'));
    assert.ok(!withAuth.label.includes('s3cret') && !withAuth.label.includes('me'));
    assert.equal(parseProxy('http://proxy.example').port, 80);
    assert.deepEqual(parseProxy('socks5://127.0.0.1:9050'), { kind: 'socks5', host: '127.0.0.1', port: 9050, auth: null, user: null, pass: null, label: '127.0.0.1:9050' });
    assert.equal(parseProxy('socks5h://proxy.example').port, 1080);
    const named = parseProxy('socks5://me:s3cret@proxy.example:1080');
    assert.deepEqual([named.kind, named.user, named.pass], ['socks5', 'me', 's3cret']);
    assert.ok(!named.label.includes('s3cret'));
    assert.throws(() => parseProxy('socks4://127.0.0.1:9050'), /HTTP .* and SOCKS5 .*socks4 is not spoken/);
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

describe('the Solana RPC behind the proxy', () => {
  const rpcSeen: string[] = [];
  const rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const call = JSON.parse(body) as { id: unknown; method: string };
      rpcSeen.push(call.method);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: 4242 }));
    });
  });
  before(() => listen(rpc));
  after(() => {
    rpc.close();
    rpc.closeAllConnections();
  });

  it('RPC calls go through the proxy, and the websocket is pointed at nothing', async () => {
    const url = `http://127.0.0.1:${portOf(rpc)}`;
    const direct = rpcConnection(url);
    assert.notEqual((direct as unknown as { _rpcWsEndpoint: string })._rpcWsEndpoint, NO_WEBSOCKET);
    setNodeProxy(parseProxy(`127.0.0.1:${portOf(proxyServer)}`));
    try {
      const before = forwarded.length;
      const conn = rpcConnection(url);
      assert.equal((conn as unknown as { _rpcWsEndpoint: string })._rpcWsEndpoint, NO_WEBSOCKET);
      assert.equal(await conn.getSlot(), 4242);
      assert.equal(forwarded.length, before + 1);
      assert.ok(forwarded.at(-1)!.url.startsWith(url) && forwarded.at(-1)!.body.includes('"getSlot"'));
      assert.equal(rpcSeen.at(-1), 'getSlot');
    } finally {
      setNodeProxy(null);
    }
  });

  it('with the proxy gone the RPC hears nothing', async () => {
    const dead = createServer();
    await listen(dead);
    const port = portOf(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    setNodeProxy(parseProxy(`127.0.0.1:${port}`));
    try {
      const heard = rpcSeen.length;
      await assert.rejects(rpcConnection(`http://127.0.0.1:${portOf(rpc)}`).getSlot());
      assert.equal(rpcSeen.length, heard);
    } finally {
      setNodeProxy(null);
    }
  });

  it('a transaction is confirmed by asking for its status: confirmed, failed, or too old', async () => {
    const source = (statuses: unknown[], height = 10) => {
      let i = 0;
      return { getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [statuses[Math.min(i++, statuses.length - 1)]] }), getBlockHeight: async () => height } as unknown as Parameters<typeof pollStatus>[0];
    };
    assert.equal(await pollStatus(source([null, { confirmationStatus: 'processed', err: null }, { confirmationStatus: 'confirmed', err: null }]), 'sig', 100, 1), null);
    assert.deepEqual(await pollStatus(source([null, { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }]), 'sig', 100, 1), { InstructionError: [0, 'Custom'] });
    await assert.rejects(pollStatus(source([null], 101), 'sig', 100, 1), /block height exceeded: sig expired/);
  });

  it('behind a proxy a transaction is sent and polled, never subscribed to', async () => {
    const payer = Keypair.generate();
    const calls: string[] = [];
    const conn = {
      getLatestBlockhash: async () => (calls.push('getLatestBlockhash'), { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 50 }),
      sendRawTransaction: async (raw: Buffer) => (calls.push('sendRawTransaction'), assert.ok(raw.length > 64), 'the-signature'),
      getSignatureStatuses: async () => (calls.push('getSignatureStatuses'), { value: [{ confirmationStatus: 'confirmed', err: null }] }),
      getBlockHeight: async () => 1,
      confirmTransaction: async () => { throw new Error('a subscription was opened'); },
    } as unknown as Connection;
    const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
    setNodeProxy(parseProxy('127.0.0.1:9'));
    try {
      assert.equal(await sendOne(conn, tx(), [payer]), 'the-signature');
      assert.deepEqual(calls, ['getLatestBlockhash', 'sendRawTransaction', 'getSignatureStatuses']);
    } finally {
      setNodeProxy(null);
    }
  });

  it('nothing opens its own RPC connection, subscribes for a confirmation, or fetches on its own', () => {
    const dir = new URL('../src/', import.meta.url);
    const local = ['sse.ts', 'proxy.ts', 'mcp.ts', 'bench.ts', 'connect.ts', 'run.ts', 'provider/init.ts', 'router/console.ts', 'provider/console.ts'];
    for (const f of (readdirSync(dir, { recursive: true }) as string[]).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      if (f !== 'chain/connect.ts') assert.ok(!src.includes('new Connection('), `${f} opens its own RPC connection; use rpcConnection`);
      if (f !== 'chain/send.ts') assert.ok(!/sendAndConfirmTransaction\(|\.confirmTransaction\(/.test(src), `${f} confirms by subscription; use sendOne or confirmed`);
      if (!local.includes(f)) assert.ok(!/(^|[^.\w])fetch\(|fetch as unknown/m.test(src), `${f} calls fetch itself; use fetchNode or outFetch`);
    }
  });
});

describe('an IPv6 address', () => {
  it('becomes the 16 bytes SOCKS5 sends, short forms and an IPv4 tail included', () => {
    assert.equal(ipv6Bytes('::1').toString('hex'), '00000000000000000000000000000001');
    assert.equal(ipv6Bytes('::').toString('hex'), '0'.repeat(32));
    assert.equal(ipv6Bytes('2001:db8::5').toString('hex'), '20010db8000000000000000000000005');
    assert.equal(ipv6Bytes('[fe80::1%en0]').toString('hex'), 'fe800000000000000000000000000001');
    assert.equal(ipv6Bytes('::ffff:192.0.2.1').toString('hex'), '00000000000000000000ffffc0000201');
    assert.equal(ipv6Bytes('2001:0db8:0000:0000:0000:ff00:0042:8329').toString('hex'), '20010db8000000000000ff0000428329');
    assert.throws(() => ipv6Bytes('1:2:3'), /not an IPv6 address/);
  });

  it('is asked of an HTTP proxy in brackets (CONNECT [::1]:port), and the tunnel works', async (t) => {
    const six = createServer(handler);
    try {
      await new Promise<void>((r, f) => { six.once('error', f); six.listen(0, '::1', () => r()); });
    } catch {
      return t.skip('no IPv6 loopback here');
    }
    try {
      const sock = await httpTunnel(parseProxy(`127.0.0.1:${portOf(proxyServer)}`), '::1', portOf(six));
      assert.equal(tunnels.at(-1)!.to, `[::1]:${portOf(six)}`);
      const said = await new Promise<string>((done) => {
        let got = '';
        sock.on('data', (d) => (got += d));
        sock.on('end', () => done(got));
        sock.write(`GET /v1/models HTTP/1.1\r\nhost: [::1]:${portOf(six)}\r\nconnection: close\r\n\r\n`);
      });
      assert.match(said, /^HTTP\/1\.1 200/);
    } finally {
      six.closeAllConnections();
      six.close();
    }
  });
});

describe('a SOCKS5 proxy', () => {
  // A small SOCKS5 server (RFC 1928 and 1929): no sign-in, or a name and password. It writes down where each tunnel
  // went and what passed through. curl is run against it first, so the client under test is checked against a server
  // that a reference client also accepts.
  const asked: { to: string; bytes: Buffer[]; user?: string }[] = [];
  // How each tunnel named its target: 1 an IPv4 address, 3 a name, 4 an IPv6 address.
  const kinds: number[] = [];
  const sixOf = (b: Buffer) => new URL(`http://[${[...Array(8)].map((_, i) => b.readUInt16BE(i * 2).toString(16)).join(':')}]/`).hostname.slice(1, -1);
  const cfg = { need: null as { user: string; pass: string } | null, refuse: 0 };
  const socks = createTcpServer((c: Socket) => {
    let buf = Buffer.alloc(0), step = 0, user: string | undefined;
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (step === 0) {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + buf[1]);
          const pick = cfg.need ? (methods.includes(2) ? 2 : 255) : methods.includes(0) ? 0 : 255;
          c.write(Buffer.from([5, pick]));
          if (pick === 255) return void c.end();
          step = pick === 2 ? 1 : 2;
        } else if (step === 1) {
          if (buf.length < 2 || buf.length < 2 + buf[1] + 1) return;
          const ulen = buf[1], plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          user = buf.subarray(2, 2 + ulen).toString();
          const ok = user === cfg.need!.user && buf.subarray(3 + ulen, 3 + ulen + plen).toString() === cfg.need!.pass;
          buf = buf.subarray(3 + ulen + plen);
          c.write(Buffer.from([1, ok ? 0 : 1]));
          if (!ok) return void c.end();
          step = 2;
        } else if (step === 2) {
          if (buf.length < 5) return;
          const len = buf[3] === 1 ? 4 : buf[3] === 3 ? 1 + buf[4] : 16;
          if (buf.length < 4 + len + 2) return;
          const host = buf[3] === 1 ? [...buf.subarray(4, 8)].join('.') : buf[3] === 4 ? sixOf(buf.subarray(4, 20)) : buf.subarray(5, 5 + buf[4]).toString();
          kinds.push(buf[3]);
          const port = buf.readUInt16BE(4 + len);
          const rest = buf.subarray(4 + len + 2);
          step = 3;
          c.off('data', onData);
          if (cfg.refuse) return void c.end(Buffer.from([5, cfg.refuse, 0, 1, 0, 0, 0, 0, 0, 0]));
          const rec = { to: `${host}:${port}`, bytes: [] as Buffer[], user };
          asked.push(rec);
          const up = connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
            c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (rest.length) { rec.bytes.push(rest); up.write(rest); }
            c.on('data', (x: Buffer) => rec.bytes.push(x));
            c.pipe(up);
            up.pipe(c);
          });
          up.on('error', () => c.destroy());
          c.on('error', () => up.destroy());
          return;
        } else return;
      }
    };
    c.on('data', onData);
    c.on('error', () => undefined);
  });
  before(() => new Promise<void>((r) => socks.listen(0, '127.0.0.1', () => r())));
  after(() => socks.close());
  const at = () => `127.0.0.1:${(socks.address() as AddressInfo).port}`;

  it('the test server is one a reference client accepts (curl)', async (t) => {
    let out: string;
    try {
      // Not execFileSync: the servers curl talks to live in this process and need its event loop.
      out = (await promisify(execFile)('curl', ['-sS', '--max-time', '10', '--socks5-hostname', at(), `http://127.0.0.1:${portOf(plain)}/v1/models`], { encoding: 'utf8' })).stdout;
    } catch (e) {
      // Only a missing curl skips this; a curl that ran and failed means the test server is wrong.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('curl is not here');
      throw e;
    }
    assert.deepEqual(JSON.parse(out), { method: 'GET', url: '/v1/models', got: 0 });
    assert.equal(asked.at(-1)!.to, `127.0.0.1:${portOf(plain)}`);
  });

  it('a plain-http node is reached through a tunnel, with the name sent to the proxy', async () => {
    const proxy = parseProxy(`socks5://${at()}`);
    const r = await viaProxy(proxy, `http://localhost:${portOf(plain)}/v1/chat/completions?x=1`, { method: 'POST', headers: { 'x-orrery-wire': '1' }, body: JSON.stringify({ sealed: 'abc' }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { method: 'POST', url: '/v1/chat/completions?x=1', got: 16 });
    assert.equal(asked.at(-1)!.to, `localhost:${portOf(plain)}`, 'the proxy got the name, not an address this machine looked up');
    assert.equal(seen.at(-1)!.headers['x-orrery-wire'], '1');
    const stream = await viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/stream`);
    assert.equal(await stream.text(), 'data: one\n\ndata: two\n\n');
  });

  it('an https node is reached by TLS inside the tunnel: the proxy sees where, and none of what', async (t) => {
    if (!secure || !ca) return t.skip('openssl is not here to make a certificate');
    const proxy = parseProxy(`socks5://${at()}`);
    const r = await viaProxy(proxy, `https://localhost:${portOf(secure)}/v1/chat/completions`, { method: 'POST', body: SECRET }, { ca });
    assert.deepEqual(await r.json(), { method: 'POST', url: '/v1/chat/completions', got: SECRET.length });
    const carried = Buffer.concat(asked.at(-1)!.bytes);
    assert.equal(asked.at(-1)!.to, `localhost:${portOf(secure)}`);
    assert.ok(carried.length > SECRET.length && !carried.includes(SECRET) && !carried.includes('/v1/chat/completions'));
    await assert.rejects(viaProxy(proxy, `https://localhost:${portOf(secure)}/v1/models`), /TLS to localhost through the proxy/);
  });

  it('signs in with a name and password when the proxy asks, and says so when they are wrong or missing', async () => {
    cfg.need = { user: 'me', pass: 's3cret' };
    try {
      const ok = await viaProxy(parseProxy(`socks5://me:s3cret@${at()}`), `http://127.0.0.1:${portOf(plain)}/v1/models`);
      assert.equal(ok.status, 200);
      assert.equal(asked.at(-1)!.user, 'me');
      await assert.rejects(viaProxy(parseProxy(`socks5://me:wrong@${at()}`), `http://127.0.0.1:${portOf(plain)}/v1/models`), /did not accept the name and password/);
      await assert.rejects(viaProxy(parseProxy(`socks5://${at()}`), `http://127.0.0.1:${portOf(plain)}/v1/models`), /accepts no way of signing in/);
    } finally {
      cfg.need = null;
    }
  });

  it('a proxy that cannot reach the node, is gone, or is not SOCKS at all is an error that names it; nothing goes out directly', async () => {
    cfg.refuse = 5;
    try {
      await assert.rejects(viaProxy(parseProxy(`socks5://${at()}`), `http://127.0.0.1:${portOf(plain)}/v1/models`), /could not reach 127\.0\.0\.1:\d+ \(connection refused\)/);
    } finally {
      cfg.refuse = 0;
    }
    const heard = seen.length;
    await assert.rejects(viaProxy(parseProxy(`socks5://127.0.0.1:${portOf(proxyServer)}`), `http://127.0.0.1:${portOf(plain)}/v1/models`, { timeoutMs: 2_000 }), /does not speak SOCKS5|closed the connection|timeout/);
    const dead = createServer();
    await listen(dead);
    const port = portOf(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    await assert.rejects(viaProxy(parseProxy(`socks5://127.0.0.1:${port}`), `http://127.0.0.1:${portOf(plain)}/v1/models`), /did not answer/);
    assert.equal(seen.length, heard);
  });

  it('a node written as an IPv6 address is reached through it: the proxy is sent the address itself, as curl sends it', async (t) => {
    const six = createServer(handler);
    try {
      await new Promise<void>((r, f) => { six.once('error', f); six.listen(0, '::1', () => r()); });
    } catch {
      return t.skip('no IPv6 loopback here');
    }
    try {
      const url = `http://[::1]:${portOf(six)}/v1/models`;
      try {
        const out = (await promisify(execFile)('curl', ['-sS', '--max-time', '10', '--socks5', at(), url], { encoding: 'utf8' })).stdout;
        assert.deepEqual(JSON.parse(out), { method: 'GET', url: '/v1/models', got: 0 });
        assert.deepEqual([asked.at(-1)!.to, kinds.at(-1)], [`::1:${portOf(six)}`, 4], 'curl names an IPv6 target by its 16 bytes');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const r = await viaProxy(parseProxy(`socks5://${at()}`), url);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { method: 'GET', url: '/v1/models', got: 0 });
      assert.deepEqual([asked.at(-1)!.to, kinds.at(-1)], [`::1:${portOf(six)}`, 4], 'so does the router');
      assert.equal(seen.at(-1)!.headers.host, `[::1]:${portOf(six)}`, 'the node is told its own address in brackets');
      cfg.refuse = 4;
      const s6 = await socksTunnel(parseProxy(`socks5://${at()}`), '2001:db8::5', 80).then(() => 'opened', (e: Error) => e.message).finally(() => (cfg.refuse = 0));
      assert.match(s6, /could not reach \[2001:db8::5\]:80 \(host unreachable\)/, 'an address the proxy cannot reach is named in brackets');
    } finally {
      six.closeAllConnections();
      six.close();
    }
  });

  it('the Solana RPC goes through it too', async () => {
    const rpc = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(body) as { id: unknown }).id, result: 77 })));
    });
    await listen(rpc);
    setNodeProxy(parseProxy(`socks5://${at()}`));
    try {
      assert.equal(await rpcConnection(`http://127.0.0.1:${portOf(rpc)}`).getSlot(), 77);
      assert.equal(asked.at(-1)!.to, `127.0.0.1:${portOf(rpc)}`);
    } finally {
      setNodeProxy(null);
      rpc.close();
      rpc.closeAllConnections();
    }
  });
});

describe('tunnels kept between requests', () => {
  it('three requests to one https host ride one tunnel', async (t) => {
    if (!secure || !ca) return t.skip('openssl is not here to make a certificate');
    const tls = { ca };
    const url = `https://localhost:${portOf(secure)}/v1/models`;
    const http = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    const before = tunnels.length;
    for (let i = 0; i < 3; i++) assert.equal((await (await viaProxy(http, url, {}, tls)).json() as { url: string }).url, '/v1/models');
    assert.equal(tunnels.length, before + 1);
  });

  it('a kept tunnel the far end has closed is replaced once, and the request still answers', async (t) => {
    if (!secure || !ca) return t.skip('openssl is not here to make a certificate');
    const tls = { ca };
    const url = `https://localhost:${portOf(secure)}/v1/models`;
    const proxy = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    const before = tunnels.length;
    assert.equal((await viaProxy(proxy, url, {}, tls)).status, 200);
    secure.closeIdleConnections();
    await new Promise((r) => setTimeout(r, 30));
    const again = await viaProxy(proxy, url, {}, tls);
    assert.equal(again.status, 200);
    await again.text();
    assert.equal(tunnels.length, before + 2);
  });

  it('plain-http requests share one connection to an HTTP proxy', async () => {
    const proxy = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    const first = await viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/v1/models`);
    await first.text();
    const opened = proxyConnections;
    for (let i = 0; i < 3; i++) await (await viaProxy(proxy, `http://127.0.0.1:${portOf(plain)}/v1/models`)).text();
    assert.equal(proxyConnections, opened);
  });

  it('an answer nobody reads holds its own tunnel and does not block the next request', async (t) => {
    if (!secure || !ca) return t.skip('openssl is not here to make a certificate');
    const tls = { ca };
    const proxy = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    const before = tunnels.length;
    const unread = await viaProxy(proxy, `https://localhost:${portOf(secure)}/v1/models`, {}, tls);
    const next = await viaProxy(proxy, `https://localhost:${portOf(secure)}/v1/models`, {}, tls);
    assert.equal(next.status, 200);
    await next.text();
    assert.equal(tunnels.length, before + 2);
    await unread.body?.cancel();
  });

  it('changing the proxy closes the tunnels kept for the old one', async () => {
    const proxy = parseProxy(`127.0.0.1:${portOf(proxyServer)}`);
    setNodeProxy(proxy);
    await (await fetchNode(`http://127.0.0.1:${portOf(plain)}/v1/models`)).text();
    const live = () => new Promise<number>((r) => proxyServer.getConnections((_e, n) => r(n)));
    assert.ok((await live()) >= 1);
    setNodeProxy(null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await live(), 0);
  });
});
