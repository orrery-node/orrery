import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchNode, parseProxy, relayUnreachable, setNodeRelay, nodeRelay, type Proxy } from '../src/proxy.ts';
import { relayChoices, relayDownLine } from '../src/doctor.ts';

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
});
