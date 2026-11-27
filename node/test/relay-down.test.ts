import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchNode, nodeAddress, nodeRelays, parseProxy, pickRelay, relayFor, relayUnreachable, setNodeRelay, setNodeRelays, nodeRelay, type Proxy } from '../src/proxy.ts';
import { spreadLine } from '../src/doctor.ts';
import { nodesViaLine, noPeerRelayLine, peersReport, relayChoices, relayChoicesJson, relayDownLine, SPREAD_WAITS, spreadByNode, spreadHintLine } from '../src/doctor.ts';

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

  it('spreads nodes over several relays, each node always through the same one, and a relay leaving moves only its own nodes', () => {
    const a = parseProxy('http://10.0.0.2:7272');
    const b = parseProxy('http://10.0.0.3:7272');
    const c = parseProxy('http://10.0.0.4:7272');
    assert.equal(pickRelay('127.0.0.1:7001', []), null);
    assert.equal(pickRelay('127.0.0.1:7001', [a]), a);
    const seen = new Set<Proxy>();
    for (let p = 7000; p < 7040; p++) {
      const t = `127.0.0.1:${p}`;
      const r = pickRelay(t, [a, b, c])!;
      assert.equal(pickRelay(t, [c, a, b]), r);
      seen.add(r);
      if (r !== b) assert.equal(pickRelay(t, [a, c]), r);
      else assert.ok(pickRelay(t, [a, c]) !== b);
    }
    assert.equal(seen.size, 3);
    assert.equal(nodeAddress('https://node.example.com/v1/chat'), 'node.example.com:443');
    assert.equal(nodeAddress('http://127.0.0.1:7001/health'), '127.0.0.1:7001');
    setNodeRelays([a, b]);
    try {
      assert.equal(relayFor('http://127.0.0.1:7001/health'), pickRelay('127.0.0.1:7001', [a, b]));
      assert.equal(relayFor('https://node.example.com/v1/chat'), pickRelay('node.example.com:443', [a, b]));
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
    const live = createServer((q, s) => s.writeHead(502).end('the live relay only answers 502 in this test'));
    const livePort = await listen(live);
    const ok = parseProxy(`http://127.0.0.1:${livePort}`);
    const target = `127.0.0.1:${nodePort}`;
    // A closed port that this node would be sent through, next to the live relay.
    let dead = ok;
    let deadPort = 0;
    for (let i = 0; i < 40 && dead === ok; i++) {
      const gone = createServer();
      deadPort = await listen(gone);
      await close(gone);
      const candidate = parseProxy(`http://127.0.0.1:${deadPort}`);
      if (pickRelay(target, [candidate, ok]) === candidate) dead = candidate;
    }
    assert.ok(dead !== ok);
    const list = [dead, ok];
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

  it('lists which peer relay each node goes through under --spread-relays', () => {
    const rows = [{ address: 'a1', name: 'Kestrel GPU Co-op', via: 'http://10.0.0.2:7272' }, { address: 'b2', via: 'http://10.0.0.3:7272' }, { address: 'c3', name: 'Off', via: null }];
    assert.deepEqual(spreadByNode(rows), ['  Kestrel GPU Co-op \u2192 http://10.0.0.2:7272', '  b2 \u2192 http://10.0.0.3:7272']);
    const out = peersReport({ peers: [], relay: null, peerRelays: ['http://10.0.0.2:7272', 'http://10.0.0.3:7272'], proxyViaPeers: true, providers: rows });
    assert.ok(out.includes('  Kestrel GPU Co-op \u2192 http://10.0.0.2:7272'));
    assert.ok(!peersReport({ peers: [], relay: null, peerRelays: ['http://10.0.0.2:7272'], peerRelay: 'http://10.0.0.2:7272', proxyViaPeers: true, providers: rows }).some((l) => l.includes('\u2192')));
  });

  it('orrery peers --relays points at --spread-relays when two or more signed peers offer a relay, never for unsigned ones', () => {
    const row = { pinned: false, by: 'k', signed: true, nodes: 0, refused: null, at: 1, missed: 0 };
    const two = relayChoices([{ ...row, url: 'http://10.0.0.2:7171', relayPort: 7272, relayOpen: 0 }, { ...row, url: 'http://10.0.0.3:7171', relayPort: 7272, relayOpen: 1 }]);
    assert.equal(two.at(-1), spreadHintLine(2));
    const oneSigned = relayChoices([{ ...row, url: 'http://10.0.0.2:7171', relayPort: 7272, relayOpen: 0 }, { ...row, url: 'http://10.0.0.3:7171', relayPort: 7272, relayOpen: 1, signed: false }]);
    assert.ok(!oneSigned.some((l) => l.includes('--spread-relays')));
  });

  it('marks the relay in use in orrery peers --relays', () => {
    const row = { pinned: false, by: 'k', signed: true, nodes: 0, refused: null, at: 1, missed: 0 };
    const peersNow = [{ ...row, url: 'http://10.0.0.2:7171', relayPort: 7272, relayOpen: 0 }, { ...row, url: 'http://10.0.0.3:7171', relayPort: 7272, relayOpen: 1 }];
    const out = relayChoices(peersNow, false, ['http://10.0.0.3:7272']);
    assert.ok(out.includes('  --proxy http://10.0.0.3:7272  (http://10.0.0.3:7171, 1 open now)  \u2190 in use now'));
    assert.ok(out.includes('  --proxy http://10.0.0.2:7272  (http://10.0.0.2:7171, 0 open now)'));
    assert.deepEqual(relayChoices(peersNow), relayChoices(peersNow, false, []));
  });

  it('gives the peers\' relays as data for --relays --json, the usable ones first, with why the others are left out', () => {
    const row = { pinned: false, by: 'k', signed: true, nodes: 0, refused: null, at: 1, missed: 0 };
    const out = relayChoicesJson([
      { ...row, url: 'http://10.0.0.2:7171', relayPort: 7272, relayOpen: 2, readMs: 30 },
      { ...row, url: 'http://10.0.0.3:7171', relayPort: 7272, relayOpen: 0, relayFull: true },
      { ...row, url: 'http://10.0.0.4:7171', relayPort: 7272, relayOpen: 0, relayDownFor: 120 },
      { ...row, url: 'http://10.0.0.5:7171', relayPort: 7272, relayOpen: 1, readMs: 5 },
      { ...row, url: 'http://10.0.0.6:7171', relayPort: 7272, at: 0 },
    ], false, ['http://10.0.0.5:7272']);
    assert.deepEqual(out.relays.map((r) => [r.proxy, r.usable, r.inUse]), [['http://10.0.0.5:7272', true, true], ['http://10.0.0.2:7272', true, false], ['http://10.0.0.3:7272', false, false], ['http://10.0.0.4:7272', false, false]]);
    assert.equal(out.relays.find((r) => r.proxy === 'http://10.0.0.3:7272')?.full, true);
    assert.equal(out.relays.find((r) => r.proxy === 'http://10.0.0.4:7272')?.downFor, 120);
    assert.deepEqual(out.inUse, ['http://10.0.0.5:7272']);
  });

  it('says --spread-relays waits for a second signed peer\'s relay while only one is in use', () => {
    const one = nodesViaLine({ peerRelay: 'http://10.0.0.2:7272', peerRelays: ['http://10.0.0.2:7272'], proxyViaPeers: true, spreadRelays: true });
    assert.equal(one, `your requests to nodes: through http://10.0.0.2:7272, a peer's relay (--proxy-via-peers); the nodes see that router, not this computer${SPREAD_WAITS}`);
    assert.ok(!nodesViaLine({ peerRelay: 'http://10.0.0.2:7272', peerRelays: ['http://10.0.0.2:7272'], proxyViaPeers: true })!.includes('--spread-relays'));
  });
});
