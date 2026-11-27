import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { allowedTargets, bytesText, HOLDER_HEADER, plainAddress, Relay, RELAY_HOLDER_FACTOR, RELAY_PER_CLIENT, targetKey } from '../src/router/relay.ts';
import { httpTunnel, parseProxy, ProxyRefused } from '../src/proxy.ts';

describe('a relay only reaches listed nodes', () => {
  it('keys each node endpoint by host and port, with the default port when none is written', () => {
    assert.deepEqual([...allowedTargets(['https://node.example.com', 'http://127.0.0.1:7272/', 'https://[::1]:8443', 'ftp://x', 'not a url'])], ['node.example.com:443', '127.0.0.1:7272', '::1:8443']);
    assert.equal(targetKey('NODE.example.com', '', 'https:'), 'node.example.com:443');
    assert.equal(targetKey('127.0.0.1', 80, 'http:'), '127.0.0.1:80');
  });

  it('carries up to its limit of connections for one address at a time and turns the next away with 429 until one finishes', async () => {
    assert.equal(RELAY_PER_CLIENT, 16);
    const up = createServer((_q, s) => s.end('ok'));
    await new Promise<void>((d) => up.listen(0, '127.0.0.1', () => d()));
    const upPort = (up.address() as AddressInfo).port;
    const relay = new Relay({ allowed: () => new Set([`127.0.0.1:${upPort}`]), perClient: () => 1 });
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const rp = (relay.server.address() as AddressInfo).port;
    const tunnel = () => new Promise<{ sock: Socket; head: string }>((done) => {
      let got = '';
      const sock = connect(rp, '127.0.0.1', () => sock.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nhost: 127.0.0.1:${upPort}\r\n\r\n`));
      sock.on('data', (c) => {
        got += c.toString('latin1');
        if (got.includes('\r\n\r\n')) done({ sock, head: got.split('\r\n')[0] });
      });
    });
    const forward = () => new Promise<{ status: number; body: string }>((done) => {
      const q = request({ host: '127.0.0.1', port: rp, path: `http://127.0.0.1:${upPort}/x`, agent: false }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => done({ status: r.statusCode ?? 0, body: b }));
      });
      q.end();
    });
    const settle = async (open: number) => {
      for (let i = 0; i < 50 && relay.open !== open; i++) await new Promise((r) => setTimeout(r, 20));
    };
    const held = await tunnel();
    assert.equal(held.head, 'HTTP/1.1 200 Connection Established');
    assert.equal(relay.open, 1);
    const turned = await tunnel();
    assert.equal(turned.head, 'HTTP/1.1 429 Too Many Requests');
    const busy = await forward();
    assert.equal(busy.status, 429);
    assert.equal(JSON.parse(busy.body).error.message, 'this relay carries up to 1 connection at a time for one address; wait for one to finish');
    assert.equal(relay.refused, 2);
    held.sock.destroy();
    turned.sock.destroy();
    await settle(0);
    assert.equal(relay.open, 0);
    const ok = await forward();
    assert.deepEqual(ok, { status: 200, body: 'ok' });
    await settle(0);
    assert.equal(relay.open, 0);
    relay.server.closeAllConnections();
    up.closeAllConnections();
    await new Promise((d) => relay.server.close(d));
    await new Promise((d) => up.close(d));
  });

  it('a tunnel the relay will not open fails as the proxy refusing, with its status, not as the node failing', async () => {
    const relay = new Relay({ allowed: () => new Set() });
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const port = (relay.server.address() as AddressInfo).port;
    const err = await httpTunnel(parseProxy(`http://127.0.0.1:${port}`), '127.0.0.1', 9).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ProxyRefused);
    assert.equal((err as ProxyRefused).status, 403);
    assert.equal((err as Error).message, `the proxy at 127.0.0.1:${port} refused a tunnel to 127.0.0.1:9 (403)`);
    relay.server.closeAllConnections();
    await new Promise((d) => relay.server.close(d));
  });

  it('with clientAllowed, carries nothing for an address it does not allow, tunnels and forwarded requests alike', async () => {
    assert.equal(plainAddress('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(plainAddress('::1'), '::1');
    const relay = new Relay({ allowed: () => new Set(['127.0.0.1:9']), clientAllowed: () => false });
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const port = (relay.server.address() as AddressInfo).port;
    const err = await httpTunnel(parseProxy(`http://127.0.0.1:${port}`), '127.0.0.1', 9).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ProxyRefused);
    assert.equal((err as ProxyRefused).status, 403);
    const body = await new Promise<string>((done) => {
      const q = request({ host: '127.0.0.1', port, path: 'http://127.0.0.1:9/x', agent: false }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => done(b)); });
      q.end();
    });
    assert.equal(JSON.parse(body).error.message, 'this relay carries traffic only for its peer routers');
    assert.equal(relay.refused, 2);
    relay.server.closeAllConnections();
    await new Promise((d) => relay.server.close(d));
  });

  it('with a daily limit, turns new connections away once the day\'s bytes are carried, and says when it carries again', async () => {
    assert.equal(bytesText(1536), '1.5 KB');
    const relay = new Relay({ allowed: () => new Set(['127.0.0.1:9']), maxBytes: () => 10 });
    (relay as unknown as { count: (n: number) => void }).count(12);
    assert.equal(relay.today, 12);
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const port = (relay.server.address() as AddressInfo).port;
    const body = await new Promise<string>((done) => {
      const q = request({ host: '127.0.0.1', port, path: 'http://127.0.0.1:9/x', agent: false }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => done(b)); });
      q.end();
    });
    const err = JSON.parse(body).error;
    assert.equal(err.code, 'relay_full');
    assert.equal(err.message, 'this relay has carried its 10 B for today; it carries again in about 24 h');
    relay.server.closeAllConnections();
    await new Promise((d) => relay.server.close(d));
  });

  it('logs once when the day\'s limit is reached, not again for the bytes after it', () => {
    const said: string[] = [];
    const relay = new Relay({ allowed: () => new Set(), maxBytes: () => 10, log: (l) => said.push(l) });
    const count = (relay as unknown as { count: (n: number) => void }).count.bind(relay);
    count(6);
    assert.deepEqual(said, []);
    count(6);
    count(6);
    assert.deepEqual(said, ['relay: carried its 10 B for today; new connections are turned away for about 24 h, the ones open now finish']);
  });

  it('past its daily limit, still carries a router that shows it holds $OREY, and nobody else', async () => {
    const relay = new Relay({ allowed: () => new Set(['127.0.0.1:9']), maxBytes: () => 10, holder: async (proof) => proof === 'good' });
    (relay as unknown as { count: (n: number) => void }).count(12);
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const port = (relay.server.address() as AddressInfo).port;
    const code = (headers: Record<string, string>) => new Promise<string>((done) => {
      const q = request({ host: '127.0.0.1', port, path: 'http://127.0.0.1:9/x', agent: false, headers }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => done(b.includes('relay_full') ? 'full' : `${r.statusCode}`)); });
      q.on('error', () => done('error'));
      q.end();
    });
    assert.equal(await code({}), 'full');
    assert.equal(await code({ [HOLDER_HEADER]: 'bad' }), 'full');
    assert.notEqual(await code({ [HOLDER_HEADER]: 'good' }), 'full');
    assert.equal(relay.forHolders, 1);
    relay.server.closeAllConnections();
    await new Promise((d) => relay.server.close(d));
  });

  it('counts the routers it carried today, each address once', async () => {
    const up = createServer((_q, s) => s.end('ok'));
    await new Promise<void>((d) => up.listen(0, '127.0.0.1', () => d()));
    const upPort = (up.address() as AddressInfo).port;
    const relay = new Relay({ allowed: () => new Set([`127.0.0.1:${upPort}`]), perClient: () => 4 });
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const rp = (relay.server.address() as AddressInfo).port;
    const forward = () => new Promise<number>((done) => {
      const q = request({ host: '127.0.0.1', port: rp, path: `http://127.0.0.1:${upPort}/x`, agent: false }, (r) => { r.resume(); r.on('end', () => done(r.statusCode ?? 0)); });
      q.end();
    });
    try {
      assert.equal(relay.routersToday, 0);
      assert.equal(await forward(), 200);
      assert.equal(await forward(), 200);
      assert.equal(relay.relayed, 2);
      assert.equal(relay.routersToday, 1);
    } finally {
      relay.server.closeAllConnections();
      await new Promise((d) => relay.server.close(d));
      up.closeAllConnections();
      await new Promise((d) => up.close(d));
    }
  });

  it('lets a router that shows it holds $OREY open twice the connections at a time', async () => {
    assert.equal(RELAY_HOLDER_FACTOR, 2);
    const up = createServer((_q, s) => s.end('ok'));
    await new Promise<void>((d) => up.listen(0, '127.0.0.1', () => d()));
    const upPort = (up.address() as AddressInfo).port;
    const relay = new Relay({ allowed: () => new Set([`127.0.0.1:${upPort}`]), perClient: () => 1, holder: async (proof) => proof === 'holds' });
    await new Promise<void>((d) => relay.server.listen(0, '127.0.0.1', () => d()));
    const rp = (relay.server.address() as AddressInfo).port;
    const socks: Socket[] = [];
    const tunnel = (proof?: string) => new Promise<string>((done) => {
      let got = '';
      const sock = connect(rp, '127.0.0.1', () => sock.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nhost: 127.0.0.1:${upPort}\r\n${proof ? `${HOLDER_HEADER}: ${proof}\r\n` : ''}\r\n`));
      socks.push(sock);
      sock.on('data', (c) => { got += c.toString('latin1'); if (got.includes('\r\n\r\n')) done(got.split('\r\n')[0]); });
      sock.on('error', () => done(got.split('\r\n')[0] || 'error'));
    });
    try {
      assert.equal(await tunnel(), 'HTTP/1.1 200 Connection Established');
      assert.ok((await tunnel()).startsWith('HTTP/1.1 429'));
      assert.equal(await tunnel('holds'), 'HTTP/1.1 200 Connection Established');
      assert.ok((await tunnel('holds')).startsWith('HTTP/1.1 429'));
      assert.ok((await tunnel('does not')).startsWith('HTTP/1.1 429'));
    } finally {
      for (const s of socks) s.destroy();
      relay.server.closeAllConnections();
      await new Promise((d) => relay.server.close(d));
      up.closeAllConnections();
      await new Promise((d) => up.close(d));
    }
  });
});
