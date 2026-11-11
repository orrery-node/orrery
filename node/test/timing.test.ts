import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overheadMs, roundMs, serverTiming } from '../src/router/timing.ts';

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
