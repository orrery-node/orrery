import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jupQuote } from '../src/burn-jupiter.ts';

const reply = (ok: boolean, body: unknown) => async () => ({ ok, status: ok ? 200 : 400, json: async () => body });

describe('the market buy behind a burn pledge', () => {
  it('takes a quote for exactly the USDC due', async () => {
    const q = await jupQuote('U', 'T', 10_000n, { fetchFn: reply(true, { inAmount: '10000', outAmount: '5', priceImpactPct: '0.01', routePlan: [] }) });
    assert.equal(q.outAmount, '5');
  });
  it('waits when the buy would move the price too far, when the amount differs, or when there is no route', async () => {
    await assert.rejects(jupQuote('U', 'T', 10_000n, { fetchFn: reply(true, { inAmount: '10000', outAmount: '5', priceImpactPct: '0.09', routePlan: [] }) }), /move the price by 9\.00%/);
    await assert.rejects(jupQuote('U', 'T', 10_000n, { fetchFn: reply(true, { inAmount: '9', outAmount: '5', priceImpactPct: '0', routePlan: [] }) }), /another amount/);
    await assert.rejects(jupQuote('U', 'T', 10_000n, { fetchFn: reply(false, { error: 'no routes found' }) }), /no route.*no routes found/);
  });
});
