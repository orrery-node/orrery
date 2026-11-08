import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bench, median, renderBench } from '../src/bench.ts';

const entry = (name: string, address: string) => ({ address, manifest: { name, models: [{ id: 'm', price: { input: 37_500, output: 140_000 } }] } }) as never;

describe('orrery bench', () => {
  it('takes medians of odd and even samples', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });

  it('pins each ask to one provider, reads the router headers, and puts providers that answered first by first-token time', async () => {
    const seen: string[] = [];
    let clock = 0;
    const fetchFn = async (_url: string, init: { headers: Record<string, string> }) => {
      const who = init.headers['x-orrery-provider'];
      seen.push(who);
      clock += who === 'fast' ? 50 : 120;
      if (who === 'dark') return { ok: false, status: 502, headers: { get: () => null }, json: async () => ({ error: { message: 'all providers failed' } }) };
      return { ok: true, status: 200, headers: { get: (h: string) => (h === 'x-orrery-cost' ? '0.000004' : h === 'x-orrery-ttft-ms' ? (who === 'fast' ? '40' : '90') : null) }, json: async () => ({}) };
    };
    const rows = await bench({ model: 'm', providers: [entry('Slow', 'slow'), entry('Dark', 'dark'), entry('Fast', 'fast')], router: 'http://r', n: 2, fetchFn, now: () => clock });
    assert.deepEqual(rows.map((r) => [r.name, r.answered, r.asked]), [['Fast', 2, 2], ['Slow', 2, 2], ['Dark', 0, 1]]);
    assert.equal(seen.filter((x) => x === 'dark').length, 1);
    const text = renderBench('m', rows);
    assert.match(text, /Fast\s+2\/2\s+40 ms/);
    assert.match(text, /Dark\s+0\/1\s+did not answer: all providers failed/);
    assert.match(text, /spent \$0\.000016 on this bench/);
  });
});
