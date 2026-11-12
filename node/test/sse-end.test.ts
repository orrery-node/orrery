import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerEvents, readSse } from '../src/sse.ts';

// A node stand-in that does what real ones do over a real network: the end of the answer arrives a moment after
// its [DONE]. `/open` never ends at all.
let connections = 0;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: one\n\n');
  res.write('event: orrery\ndata: {"cost":"12"}\n\n');
  res.write('data: [DONE]\n\n');
  if (req.url !== '/open') setTimeout(() => res.end(), 60);
});
server.on('connection', () => connections++);
before(() => new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())));
after(() => {
  server.close();
  server.closeAllConnections();
});
const url = (path = '/') => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('stopping at [DONE] drops the stream and the connection with it; reading to the end keeps the connection', async () => {
  // The old way: leave the loop at [DONE]. The stream is not finished yet, so leaving cancels it, and every request
  // after that has to open a connection of its own.
  const start = connections;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url());
    for await (const ev of readSse(r.body!)) if (ev.data === '[DONE]') break;
    await pause(20);
  }
  assert.ok(connections - start >= 3, `three requests needed ${connections - start} connections: none was reused`);

  // The way the router reads now: the first of these opens a connection (the earlier ones were dropped), and the
  // next three ride it.
  for await (const ev of answerEvents((await fetch(url())).body!)) void ev;
  await pause(20);
  const kept = connections;
  for (let i = 0; i < 3; i++) {
    const seen: string[] = [];
    for await (const ev of answerEvents((await fetch(url())).body!)) seen.push(ev.event ?? ev.data);
    assert.deepEqual(seen, ['one', 'orrery']);
    await pause(20);
  }
  assert.equal(connections - kept, 0, 'three answers rode the connection that was already open');
});

test('a node that never ends its answer is not waited on for longer than the grace', async () => {
  const t0 = Date.now();
  const seen: string[] = [];
  for await (const ev of answerEvents((await fetch(url('/open'))).body!, 80)) seen.push(ev.data);
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - t0 < 1_000);
});

test('a caller that stops early lets go of the stream', async () => {
  const r = await fetch(url('/open'));
  for await (const ev of answerEvents(r.body!)) if (ev.data === 'one') break;
  await assert.rejects(r.text());
});
