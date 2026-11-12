import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { givenAway, isPublic, readSeen, seenAddresses, seenFrom } from '../src/seen.ts';
import { render, seenCheck } from '../src/doctor.ts';
import { parseProxy, viaProxy } from '../src/proxy.ts';

const listen = (s: Server, host: string) => new Promise<number>((done, fail) => {
  s.once('error', fail);
  s.listen(0, host, () => done((s.address() as AddressInfo).port));
});

describe('what a node sees of the caller', () => {
  it('reads the connection and what a balancer wrote down, and keeps only addresses', () => {
    assert.deepEqual(seenFrom({ headers: {}, socket: { remoteAddress: '::ffff:203.0.113.9' } }), { address: '203.0.113.9', socket: '203.0.113.9', forwarded: [] });
    assert.deepEqual(seenFrom({ headers: { 'x-forwarded-for': '<script>, 192.168.4.4' }, socket: { remoteAddress: '::1' } }), { address: '192.168.4.4', socket: '::1', forwarded: ['192.168.4.4'] }, 'all private (a test on one machine or one network): said as it is');
  });

  it('once a public caller is known, the private addresses of the network in front of the node are not said', () => {
    // A node behind a hosting balancer: the caller, the balancer's public edge, then its private hop.
    assert.deepEqual(seenFrom({ headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.20, 10.0.0.3' }, socket: { remoteAddress: '10.0.0.3' } }),
      { address: '198.51.100.7', socket: '', forwarded: ['198.51.100.7', '203.0.113.20'] });
    // A forwarding proxy on the caller's own network wrote down a private address before its public one.
    assert.deepEqual(seenFrom({ headers: { 'x-forwarded-for': '192.168.1.5, 198.51.100.7' }, socket: { remoteAddress: '172.16.0.9' } }),
      { address: '198.51.100.7', socket: '', forwarded: ['198.51.100.7'] });
    assert.deepEqual(seenFrom({ headers: { 'x-forwarded-for': '2001:db8::1' }, socket: { remoteAddress: '::1' } }), { address: '2001:db8::1', socket: '', forwarded: ['2001:db8::1'] });
    assert.deepEqual(seenFrom({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }), { address: '203.0.113.9', socket: '203.0.113.9', forwarded: [] }, 'a public caller straight in: unchanged');
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

  it('a router refuses to send only when the address given away is its own and one the internet routes to', () => {
    for (const a of ['203.0.113.9', '8.8.8.8', '2001:db8::1', '100.63.255.255', '172.32.0.1']) assert.equal(isPublic(a), true, a);
    for (const a of ['127.0.0.1', '10.201.3.4', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.10.1', '100.64.0.1', '::1', 'fe80::1', 'fd12:3456::1', 'not an address', '']) assert.equal(isPublic(a), false, a);
    const own = ['198.51.100.7', '192.168.1.5'];
    // The proxy wrote this computer's public address into a header.
    assert.equal(givenAway({ address: '198.51.100.7', socket: '203.0.113.9', forwarded: ['198.51.100.7'] }, own), '198.51.100.7');
    // The proxy sends from this computer.
    assert.equal(givenAway({ address: '198.51.100.7', socket: '198.51.100.7', forwarded: [] }, own), '198.51.100.7');
    // The node saw only the proxy.
    assert.equal(givenAway({ address: '203.0.113.9', socket: '203.0.113.9', forwarded: [] }, own), null);
    // A private address that matches is not enough to stop a router: the node's own balancer may use the same one.
    assert.equal(givenAway({ address: '203.0.113.9', socket: '192.168.1.5', forwarded: ['203.0.113.9'] }, own), null);
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
