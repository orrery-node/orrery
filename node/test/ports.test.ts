import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenOn, portTaken } from '../src/ports.ts';

describe('a port that is already in use', () => {
  it('is said in words for a node and for a router, with what to do', () => {
    assert.match(portTaken('node', 7288, '0.0.0.0'), /^port 7288 on 0\.0\.0\.0 is already in use, most likely by this node from an earlier start .* set "listen" in provider\.json to a free port/);
    assert.match(portTaken('router', 7171, '127.0.0.1'), /^port 7171 on 127\.0\.0\.1 is already in use, most likely by a router from an earlier start .* --port <another port>/);
  });

  it('listenOn rejects with those words when the port is taken, and listens when it is free', async () => {
    const first = createServer();
    await listenOn(first, 0, '127.0.0.1', 'router');
    const port = (first.address() as { port: number }).port;
    const second = createServer();
    await assert.rejects(listenOn(second, port, '127.0.0.1', 'router'), (e: Error) => e.message === portTaken('router', port, '127.0.0.1'));
    first.close();
  });
});
