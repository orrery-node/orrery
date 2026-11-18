import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as check from '../src/provider/check.ts';

type Row = { model: string; mine: { input: number; output: number }; others: number; cheaper: number; lowest: { input: number; output: number } | null; myCost: bigint; lowestCost: bigint | null };
const pricesLine = (check as unknown as { pricesLine?: (rows: Row[]) => { ok: boolean | null; what: string; detail: string } | null }).pricesLine;

describe('provider check: where each price stands', () => {
  it('names each model against the other listings of it, and points to provider price when some list it cheaper', () => {
    assert.equal(typeof pricesLine, 'function', 'check.ts writes the line');
    const p = { input: 1, output: 1 };
    assert.deepEqual(pricesLine!([
      { model: 'llama-3.3-70b', mine: p, others: 2, cheaper: 1, lowest: p, myCost: 625n, lowestCost: 390n },
      { model: 'gpt-oss-120b', mine: p, others: 1, cheaper: 0, lowest: p, myCost: 145n, lowestCost: 160n },
      { model: 'gemma-3-27b', mine: p, others: 0, cheaper: 0, lowest: null, myCost: 800n, lowestCost: null },
      { model: 'qwen3-32b', mine: p, others: 1, cheaper: 1, lowest: p, myCost: 300n, lowestCost: 290n },
    ]), { ok: null, what: 'prices', detail: 'a 2,000-in / 500-out request: llama-3.3-70b at $0.000625, 1 of 2 other listings cheaper, the lowest $0.000390; gpt-oss-120b the cheapest of 2; gemma-3-27b listed by no other node; qwen3-32b at $0.000300, the one other listing cheaper at $0.000290 · orrery provider price suggests prices under the cheapest' });
  });

  it('says nothing about provider price when no listing is cheaper, and names at most four models', () => {
    const p = { input: 1, output: 1 };
    const rows = ['a', 'b', 'c', 'd', 'e'].map((m) => ({ model: m, mine: p, others: 0, cheaper: 0, lowest: null, myCost: 1n, lowestCost: null }));
    assert.equal(pricesLine!(rows)!.detail, 'a 2,000-in / 500-out request: a listed by no other node; b listed by no other node; c listed by no other node; d listed by no other node; and 1 more');
    assert.equal(pricesLine!([]), null);
  });
});
