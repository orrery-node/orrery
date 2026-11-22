import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/mcp.ts';

describe('the quote tool of orrery mcp, for pictures', () => {
  it('passes how many images to the router quote, and lists the argument for an agent to find', async () => {
    let asked = '';
    const f = (async (url: string) => { asked = url; return new Response(JSON.stringify({ text: 'quoted' }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const call = handle as unknown as (msg: unknown, router: string, f: typeof fetch, v: string) => Promise<{ result?: { content?: { text?: string }[]; tools?: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } } | null>;
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quote', arguments: { model: 'flux-schnell', images: 3 } } }, 'http://router.test', f, 'test');
    assert.equal(r?.result?.content?.[0]?.text, 'quoted');
    assert.equal(new URL(asked).searchParams.get('images'), '3');
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'http://router.test', f, 'test');
    assert.ok('images' in (list?.result?.tools?.find((t) => t.name === 'quote')?.inputSchema.properties ?? {}));
  });
});
