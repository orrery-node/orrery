import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFailedSentence } from '../src/provider/payouts.ts';

describe('a payout round that failed', () => {
  it('says when, in UTC, and the chain\'s words with what to do, and that nothing signed is lost', () => {
    assert.equal(payoutFailedSentence({ at: Date.parse('2026-11-22T12:34:56Z'), said: 'Transaction simulation failed: insufficient funds for fee; the node key has 0.000005 SOL for fees: send a little SOL to Key111' }),
      'The last payout round, at 12:34 UTC, failed: Transaction simulation failed: insufficient funds for fee; the node key has 0.000005 SOL for fees: send a little SOL to Key111. Each round tries again, and nothing signed to you is lost meanwhile.');
  });

  it('does not say twice that what was signed is safe when the chain note already says it', () => {
    assert.equal(payoutFailedSentence({ at: Date.parse('2026-11-22T01:02:00Z'), said: 'Simulation failed; the node key has 0.000000 SOL for fees: send a little SOL to Key111. What routers signed is safe and is redeemed once the key can pay' }),
      'The last payout round, at 01:02 UTC, failed: Simulation failed; the node key has 0.000000 SOL for fees: send a little SOL to Key111. What routers signed is safe and is redeemed once the key can pay. Each round tries again.');
  });

  it('says nothing when no round has failed since the last that went through', () => {
    assert.equal(payoutFailedSentence(null), '');
    assert.equal(payoutFailedSentence(undefined), '');
  });
});
