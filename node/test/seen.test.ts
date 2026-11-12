import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readSeen, seenAddresses, seenFrom } from '../src/seen.ts';
import { render, seenCheck } from '../src/doctor.ts';
import { parseProxy, viaProxy } from '../src/proxy.ts';

const listen = (s: Server, host: string) => new Promise<number>((done, fail) => {
  s.once('error', fail);
  s.listen(0, host, () => done((s.address() as AddressInfo).port));
});

describe('what a node sees of the caller', () => {
  it('reads the connection and what a balancer wrote down, and keeps only addresses', () => {
    assert.deepEqual(seenFrom({ headers: {}, socket: { remoteAddress: '::ffff:203.0.113.9' } }), { address: '203.0.113.9', socket: '203.0.113.9', forwarded: [] });
    assert.deepEqual(seenFrom({ headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.3' }, socket: { remoteAddress: '10.0.0.3' } }), { address: '198.51.100.7', socket: '10.0.0.3', forwarded: ['198.51.100.7', '10.0.0.3'] });
    assert.deepEqual(seenFrom({ headers: { 'x-forwarded-for': '<script>, 2001:db8::1' }, socket: { remoteAddress: '::1' } }), { address: '2001:db8::1', socket: '::1', forwarded: ['2001:db8::1'] });
  });

  it('a router does not print what is not an address', () => {
    assert.equal(readSeen({ address: 'rm -rf /', socket: '1.2.3.4', forwarded: [] }), null);
    assert.equal(readSeen({ error: 'not_found' }), null);
    assert.deepEqual(readSeen({ address: '203.0.113.9', socket: '\u001b[31m', forwarded: ['203.0.113.9', 7, 'x y'] }), { address: '203.0.113.9', socket: '', forwarded: ['203.0.113.9'] });
    assert.deepEqual(seenAddresses({ address: '198.51.100.7', socket: '10.0.0.3', forwarded: ['198.51.100.7', '10.0.0.3'] }), ['198.51.100.7', '10.0.0.3']);
  });

  it('doctor says it in one line, and fails the line when a proxy passes this computer’s address on', () => {
    const seen = { address: '203.0.113.9', socket: '10.0.0.3', forwarded: ['203.0.113.9', '10.0.0.3'] };
    assert.match(render([seenCheck('Orrery Seed', seen, null, [])]), /^· seen as\s+Orrery Seed sees 203\.0\.113\.9 \(also in what reached it: 10\.0\.0\.3\); no proxy is set, so that is the address this computer's requests leave from \(--proxy hides it\)$/);
    assert.match(render([seenCheck('Orrery Seed', seen, parseProxy('socks5://127.0.0.1:9050'), ['192.168.1.5'])]), /^· seen as\s+Orrery Seed sees 203\.0\.113\.9 .*through the proxy at 127\.0\.0\.1:9050; if that is not your own address, nodes do not learn yours/);
    assert.match(render([seenCheck('Orrery Seed', { address: '203.0.113.9', socket: '203.0.113.9', forwarded: [] }, parseProxy('http://203.0.113.9:3128'), [])]), /^✓ seen as\s+Orrery Seed sees 203\.0\.113\.9, the address of the proxy/);
    const leak = seenCheck('Orrery Seed', { address: '192.168.1.5', socket: '203.0.113.9', forwarded: ['192.168.1.5'] }, parseProxy('http://203.0.113.9:3128'), ['192.168.1.5']);
    assert.equal(leak.ok, false);
    assert.match(leak.detail, /192\.168\.1\.5, which is this computer's own address: the proxy at 203\.0\.113\.9:3128 passes it on in a header/);
    assert.match(render([seenCheck(null, null, null, [])]), /^· seen as\s+no node here answers GET \/v1\/seen/);
  });

  it('over real sockets: a node reached through a proxy sees the proxy, and a forwarding proxy that adds the caller is caught', async (t) => {
    const node = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seenFrom(req)));
    });
    let port: number;
    try {
      port = await listen(node, '::');
    } catch {
      return t.skip('no IPv6 loopback on this machine');
    }
    // A forwarding proxy that reaches the node from another address (::1) and, when told to, writes the caller's down.
    let tell = false;
    const proxy = createServer((req, res) => {
      const u = new URL(req.url!);
      const out = request({ host: '::1', port: u.port, path: u.pathname, method: req.method, headers: { ...req.headers, host: u.host, ...(tell ? { 'x-forwarded-for': req.socket.remoteAddress!.replace(/^::ffff:/, '') } : {}) } }, (r) => {
        res.writeHead(r.statusCode!, r.headers);
        r.pipe(res);
      });
      req.pipe(out);
    });
    const proxyPort = await listen(proxy, '127.0.0.1');
    const p = parseProxy(`http://127.0.0.1:${proxyPort}`);
    try {
      const direct = readSeen(await (await fetch(`http://127.0.0.1:${port}/v1/seen`)).json());
      assert.equal(direct?.address, '127.0.0.1');
      const through = readSeen(await (await viaProxy(p, `http://127.0.0.1:${port}/v1/seen`)).json());
      assert.equal(through?.address, '::1', 'the node sees the proxy, not the caller');
      assert.equal(seenCheck('node', through, p, ['127.0.0.1']).ok, null);
      tell = true;
      const told = readSeen(await (await viaProxy(p, `http://127.0.0.1:${port}/v1/seen`)).json());
      assert.deepEqual(told, { address: '127.0.0.1', socket: '::1', forwarded: ['127.0.0.1'] });
      assert.equal(seenCheck('node', told, p, ['127.0.0.1']).ok, false, 'the proxy passed the caller on, and doctor says so');
    } finally {
      proxy.closeAllConnections();
      node.closeAllConnections();
      proxy.close();
      node.close();
    }
  });
});
