import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchNode, nodeRelays, parseProxy, relayFor, relayIndex, relayUnreachable, setNodeRelay, setNodeRelays, nodeRelay, type Proxy } from '../src/proxy.ts';
import { spreadLine } from '../src/doctor.ts';
import { nodesViaLine, noPeerRelayLine, peersReport, relayChoices, relayDownLine } from '../src/doctor.ts';

const listen = (s: Server) => new Promise<number>((done) => s.listen(0, '127.0.0.1', () => done((s.address() as AddressInfo).port)));
const close = (s: Server) => new Promise((done) => { s.closeAllConnections(); s.close(done); });

describe('a peer relay that cannot be reached', () => {
  it('tells a relay that never answered from one that answered and said no', () => {
    assert.ok(relayUnreachable(new Error('the proxy at http://10.0.0.2:7272 did not answer: connect ECONNREFUSED 10.0.0.2:7272')));
    assert.ok(relayUnreachable(new Error('through the proxy at http://10.0.0.2:7272: connect EHOSTUNREACH 10.0.0.2:7272')));
    assert.ok(!relayUnreachable(new Error('the proxy at http://10.0.0.2:7272 refused a tunnel to node:443 (503)')));
    assert.ok(!relayUnreachable(new Error('through the proxy at http://10.0.0.2:7272: socket hang up')));
    assert.ok(!relayUnreachable(new Error('timeout after 10000ms')));
  });

  it('sends the request once more the router\'s own way, drops the relay and says which one', async () => {
    const node = createServer((_q, s) => s.end('from the node'));
    const nodePort = await listen(node);
    const gone = createServer();
    const deadPort = await listen(gone);
    await close(gone);
    const heard: string[] = [];
    setNodeRelay(parseProxy(`http://127.0.0.1:${deadPort}`), (relay: Proxy, err: Error) => heard.push(`${relay.port} ${err.message}`));
    try {
      const r = await fetchNode(`http://127.0.0.1:${nodePort}/v1/manifest`, { timeoutMs: 3_000 });
      assert.equal(await r.text(), 'from the node');
      assert.equal(nodeRelay(), null);
      assert.equal(heard.length, 1);
      assert.ok(heard[0].startsWith(`${deadPort} `) && /ECONNREFUSED/.test(heard[0]));
    } finally {
      setNodeRelay(null);
      await close(node);
    }
  });

  it('does not send again when the relay answered and refused: that request may be the relay\'s to refuse', async () => {
    const node = createServer((_q, s) => s.end('from the node'));
    const nodePort = await listen(node);
    const busy = createServer((_q, s) => s.writeHead(503).end('busy'));
    const busyPort = await listen(busy);
    let told = 0;
    setNodeRelay(parseProxy(`http://127.0.0.1:${busyPort}`), () => told++);
    try {
      const r = await fetchNode(`http://127.0.0.1:${nodePort}/v1/manifest`, { timeoutMs: 3_000 });
      assert.equal(r.status, 503);
      assert.equal(told, 0);
      assert.ok(nodeRelay() !== null);
    } finally {
      setNodeRelay(null);
      await close(node);
      await close(busy);
    }
  });

  it('leaves a relay passed over out of orrery peers --relays and says for how long', () => {
    assert.equal(relayDownLine([{ url: 'http://10.0.0.2:7171', seconds: 290 }]), '1 could not be reached and is passed over for now: http://10.0.0.2:7171 (5 more min)');
    assert.equal(relayDownLine([{ url: 'a', seconds: 20 }, { url: 'b', seconds: 61 }]), '2 could not be reached and are passed over for now: a (1 more min), b (2 more min)');
    const row = { pinned: false, by: 'k', signed: true, nodes: 0, refused: null, at: 1, missed: 0 };
    const out = relayChoices([{ ...row, url: 'http://10.0.0.2:7171', relayPort: 7272, relayOpen: 0, relayDownFor: 200 }, { ...row, url: 'http://10.0.0.3:7171', relayPort: 7272, relayOpen: 3 }]);
    assert.deepEqual(out.slice(0, 2), ['1 peer relay you can use, least busy first:', '  --proxy http://10.0.0.3:7272  (http://10.0.0.3:7171, 3 open now)']);
    assert.ok(out.includes('1 could not be reached and is passed over for now: http://10.0.0.2:7171 (4 more min)'));
    assert.ok(!out.some((l) => l.includes('--proxy http://10.0.0.2:7272')));
  });

  it('spreads nodes over several relays, each node always through the same one', () => {
    assert.equal(relayIndex('127.0.0.1:7001', 1), 0);
    const seen = new Set<number>();
    for (let p = 7000; p < 7040; p++) {
      const i = relayIndex(`127.0.0.1:${p}`, 3);
      assert.equal(relayIndex(`127.0.0.1:${p}`, 3), i);
      assert.ok(i >= 0 && i < 3);
      seen.add(i);
    }
    assert.equal(seen.size, 3);
    const a = parseProxy('http://10.0.0.2:7272');
    const b = parseProxy('http://10.0.0.3:7272');
    setNodeRelays([a, b]);
    try {
      assert.equal(relayFor('http://127.0.0.1:7001/health'), [a, b][relayIndex('127.0.0.1:7001', 2)]);
      assert.equal(relayFor('https://node.example.com/v1/chat'), [a, b][relayIndex('node.example.com:443', 2)]);
      assert.deepEqual(nodeRelays(), [a, b]);
    } finally {
      setNodeRelays([]);
    }
    assert.equal(relayFor('http://127.0.0.1:7001/health'), null);
    assert.equal(spreadLine(['http://a:1', 'http://b:2']), "spread over 2 peer relays (--spread-relays): http://a:1, http://b:2; each node is always reached through the same one, so no single peer sees all of this router's traffic");
  });

  it('drops only the spread relay that could not be reached, and the request still gets its answer', async () => {
    const node = createServer((_q, s) => s.end('from the node'));
    const nodePort = await listen(node);
    const gone = createServer();
    const deadPort = await listen(gone);
    await close(gone);
    const live = createServer((q, s) => s.writeHead(502).end('the live relay only answers 502 in this test'));
    const livePort = await listen(live);
    const dead = parseProxy(`http://127.0.0.1:${deadPort}`);
    const ok = parseProxy(`http://127.0.0.1:${livePort}`);
    const target = `127.0.0.1:${nodePort}`;
    const list = relayIndex(target, 2) === 0 ? [dead, ok] : [ok, dead];
    const heard: number[] = [];
    setNodeRelays(list, (r) => heard.push(r.port));
    try {
      const r = await fetchNode(`http://${target}/v1/manifest`, { timeoutMs: 3_000 });
      assert.equal(await r.text(), 'from the node');
      assert.deepEqual(heard, [deadPort]);
      assert.deepEqual(nodeRelays(), [ok]);
      assert.equal(nodeRelay(), ok);
    } finally {
      setNodeRelays([]);
      await close(node);
      await close(live);
    }
  });

  it('orrery peers says how this router\'s own requests reach the nodes', () => {
    assert.equal(nodesViaLine({}), null);
    assert.equal(nodesViaLine({ peerRelay: 'http://10.0.0.2:7272', peerRelays: ['http://10.0.0.2:7272'], proxyViaPeers: true }), "your requests to nodes: through http://10.0.0.2:7272, a peer's relay (--proxy-via-peers); the nodes see that router, not this computer");
    assert.equal(nodesViaLine({ peerRelay: 'http://a:1', peerRelays: ['http://a:1', 'http://b:2'], proxyViaPeers: true }), `your requests to nodes: ${spreadLine(['http://a:1', 'http://b:2'])}`);
    const row = { url: 'http://10.0.0.2:7171', pinned: false, by: 'k', signed: true, nodes: 0, refused: null, at: 1, relayPort: 7272, relayDownFor: 100 };
    assert.equal(nodesViaLine({ peerRelay: null, peerRelays: [], proxyViaPeers: true, peers: [row] }), `your requests to nodes: ${noPeerRelayLine(1)}`);
    assert.ok(peersReport({ peers: [], relay: null, peerRelays: ['http://a:1', 'http://b:2'], proxyViaPeers: true }).some((l) => l.startsWith('your requests to nodes: spread over 2 peer relays')));
  });
});
