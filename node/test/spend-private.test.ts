import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { privateSpend, privateSpendLine } from '../src/spend.ts';

const trip = (at: number, cost: string, sealed = false) => ({ at, model: 'm', provider: 'p', providerName: 'P', inputTokens: 10, outputTokens: 5, cost, ...(sealed ? { sealed: true } : {}) }) as never;

describe('what part of the bill went to an enclave', () => {
  it('counts the sealed answers in the window and what they cost, and says it under the total', () => {
    const now = Date.parse('2026-11-22T18:00:00Z');
    const trips = [trip(now - 60_000, '0.000040', true), trip(now - 120_000, '0.000020'), trip(now - 180_000, '0.000056', true), trip(now - 3 * 86_400_000, '0.001000', true)];
    const p = privateSpend(trips, 86_400_000, now);
    assert.deepEqual(p, { answers: 2, units: 96n });
    assert.equal(privateSpendLine(p, { answers: 3 }), '2 of these 3 answers went to an enclave this router verified, $0.000096 of the total (orrery sealed lists them).');
  });

  it('says nothing when no answer went to an enclave', () => {
    assert.equal(privateSpendLine({ answers: 0, units: 0n }, { answers: 5 }), '');
  });
});
