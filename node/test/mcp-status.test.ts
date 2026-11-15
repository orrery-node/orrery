import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/mcp.ts';

const reply = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

describe('orrery mcp status', () => {
  it('tells an agent which nodes have their model server down', async () => {
    const fetchFn = async (url: string) => {
      if (url.endsWith('/orrery/status')) {
        return reply({
          spentToday: '0.000040',
          channels: [{ provider: '67viFEabc', spent: '0.000040', left: '1.999960' }],
          providers: [
            { address: '67viFEabc', name: 'Ironbridge Compute', modelServer: 'up', healthMs: 4 },
            { address: 'HaLoXYZ12', name: 'Halo Compute', modelServer: 'down', healthMs: 3 },
            { address: 'OldNode99', name: null, modelServer: null, healthMs: null },
          ],
        });
      }
      return reply({ rows: [] });
    };
    const out = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }, 'http://r', fetchFn, '0')) as { result: { content: { text: string }[] } };
    const t = out.result.content[0].text;
    assert.match(t, /nodes:\nIronbridge Compute: model server up \(4 ms\)\nHalo Compute: model server down, skipped/);
    assert.doesNotMatch(t, /OldNode/);
  });

  it('tells an agent how fast each node started answering, by this router’s own clock', async () => {
    const fetchFn = async (url: string) => {
      if (url.endsWith('/orrery/status')) return reply({ spentToday: '0.000040', channels: [], providers: [{ address: '67viFEabc', name: 'Ironbridge Compute', modelServer: 'up', healthMs: 4 }] });
      if (url.includes('/orrery/spend')) return reply({ rows: [{ key: 'm', answers: 42, usd: '0.000700' }], speed: [{ provider: '67viFEabc', name: 'Ironbridge Compute', answers: 42, medianTtftMs: 934 }] });
      return reply({});
    };
    const out = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }, 'http://r', fetchFn, '0')) as { result: { content: { text: string }[] } };
    assert.match(out.result.content[0].text, /\nspeed, by this router’s own clock:\nIronbridge Compute started answering in 934 ms \(median of 42 answers in the last 24 h\)/);
  });
});
