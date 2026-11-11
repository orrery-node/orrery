import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeSaid, nodeTimingHeader, overheadMs, roundMs, serverTiming } from '../src/router/timing.ts';

test('stage times keep thousandths of a millisecond', () => {
  assert.equal(roundMs(0.21349), 0.213);
  assert.equal(roundMs(812.0004), 812);
  assert.equal(roundMs(0), 0);
});

test('Server-Timing lists the stages known so far, in order, and nothing else', () => {
  assert.equal(serverTiming({ route: 0.2134, channel: 0.004, seal: 0.31, node: 812.4, sign: 0.118 }), 'route;dur=0.213, channel;dur=0.004, seal;dur=0.31, node;dur=812.4, sign;dur=0.118');
  assert.equal(serverTiming({ seal: 0.31, route: 0.2 }), 'route;dur=0.2, seal;dur=0.31');
  assert.equal(serverTiming({ route: undefined, node: Number.NaN, seal: 1 }), 'seal;dur=1');
  assert.equal(serverTiming({}), '');
});

test('what this machine added is everything but the wait for the node', () => {
  assert.equal(overheadMs({ route: 0.2, channel: 0.01, seal: 0.3, node: 900, sign: 0.1 }), 0.61);
});

test('a node reports its own three stages, and the router reads them as the node’s word', () => {
  const header = nodeTimingHeader({ open: 0.2041, check: 0.8, upstream: 412.3336 });
  assert.equal(header, 'open;dur=0.204, check;dur=0.8, upstream;dur=412.334');
  assert.deepEqual(nodeSaid(header), { nodeOpen: 0.204, nodeCheck: 0.8, nodeUpstream: 412.334 });
  assert.deepEqual(nodeSaid(null), {});
  assert.deepEqual(nodeSaid('cache;desc="hit", check;dur=1.5, upstream;dur=-4, open;dur=9e99, total;dur=3'), { nodeCheck: 1.5 });
  assert.equal(
    serverTiming({ route: 0.2, channel: 0.004, seal: 0.3, node: 900, sign: 1.1, ...nodeSaid(header) }),
    'route;dur=0.2, channel;dur=0.004, seal;dur=0.3, node;dur=900, node-open;dur=0.204, node-check;dur=0.8, node-upstream;dur=412.334, sign;dur=1.1',
  );
});
