import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerEvents, readSse } from '../src/sse.ts';

// A node stand-in that does what real ones do over a real network: the end of the answer arrives a moment after
// its [DONE]. `/late` ends 400 ms after it, and `/open` never ends at all.
let connections = 0;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: one\n\n');
  res.write('event: orrery\ndata: {"cost":"12"}\n\n');
  res.write('data: [DONE]\n\n');
  if (req.url !== '/open') setTimeout(() => res.end(), req.url === '/late' ? 400 : 60);
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

test('a node slow to end its answer does not hold the caller: the rest is read in the background and the connection is kept', async () => {
  await (await fetch(url())).text();
  await pause(20);
  const kept = connections;
  const t0 = Date.now();
  const seen: string[] = [];
  for await (const ev of answerEvents((await fetch(url('/late'))).body!)) seen.push(ev.data);
  const waited = Date.now() - t0;
  assert.equal(seen.length, 2);
  assert.ok(waited < 330, `the caller had its answer after ${waited} ms, not the 400 the node took to end`);
  await pause(450);
  for await (const ev of answerEvents((await fetch(url())).body!)) void ev;
  assert.equal(connections - kept, 0, 'the late answer was read to its end in the background, so its connection carried the next request');
});

test('a node that never ends its answer is given up on, in the background, after the grace', async () => {
  const t0 = Date.now();
  const r = await fetch(url('/open'));
  const seen: string[] = [];
  for await (const ev of answerEvents(r.body!, { waitMs: 40, graceMs: 120 })) seen.push(ev.data);
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - t0 < 300);
  await pause(250);
  await assert.rejects(r.text(), 'the stream was let go');
});

test('a caller that stops early lets go of the stream', async () => {
  const r = await fetch(url('/open'));
  for await (const ev of answerEvents(r.body!)) if (ev.data === 'one') break;
  await assert.rejects(r.text());
});
