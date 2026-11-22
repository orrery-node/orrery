import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle, spendText } from '../src/mcp.ts';

describe('the spend tool of orrery mcp', () => {
  it('says the bill a group a line, then the total, then what went to an enclave', () => {
    const t = spendText({ since: '7d', by: 'task', rows: [{ key: 'docs-rewrite', answers: 12, usd: '0.000480' }, { key: '(no task)', answers: 1, usd: '0.000020' }], total: { key: 'total', answers: 13, usd: '0.000500' }, held: { answers: 0, line: '' }, private: { answers: 2, line: '2 of these 13 answers went to an enclave this router verified, $0.000080 of the total (orrery sealed lists them).' } });
    assert.equal(t, 'last 7d, by task\ndocs-rewrite  ·  12 answers  ·  $0.000480\n(no task)  ·  1 answer  ·  $0.000020\ntotal  ·  13 answers  ·  $0.000500\n2 of these 13 answers went to an enclave this router verified, $0.000080 of the total (orrery sealed lists them).');
    assert.equal(spendText({ since: '24h', by: 'model', rows: [], total: { key: 'total', answers: 0, usd: '0.000000' } }), 'nothing paid in the last 24h');
  });

  it('asks the router for the window and grouping given, and falls back to 24h by model on anything else', async () => {
    const asked: string[] = [];
    const f = (async (url: string) => { asked.push(url); return new Response(JSON.stringify({ since: '24h', by: 'model', rows: [], total: { key: 'total', answers: 0, usd: '0.000000' } }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const call = handle as unknown as (msg: unknown, router: string, f: typeof fetch, v: string) => Promise<unknown>;
    await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spend', arguments: { since: '30d', by: 'agent' } } }, 'http://router.test', f, 'test');
    await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spend', arguments: { since: 'forever', by: 'everything' } } }, 'http://router.test', f, 'test');
    assert.deepEqual(asked.map((u) => new URL(u).search), ['?since=30d&by=agent', '?since=24h&by=model']);
  });
});
