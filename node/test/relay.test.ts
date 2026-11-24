import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { allowedTargets, Relay, RELAY_PER_CLIENT, targetKey } from '../src/router/relay.ts';
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
});
