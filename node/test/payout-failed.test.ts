import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { payoutFailedNotice, payoutFailedSentence, redeemLines } from '../src/provider/payouts.ts';

describe('a payout round that failed', () => {
  it('says when, in UTC, and the chain\'s words with what to do, and that nothing signed is lost', () => {
    assert.equal(payoutFailedSentence({ at: Date.parse('2026-11-22T12:34:56Z'), said: 'Transaction simulation failed: insufficient funds for fee; the node key has 0.000005 SOL for fees: send a little SOL to Key111' }),
      'The last payout round, at 12:34 UTC, failed: Transaction simulation failed: insufficient funds for fee; the node key has 0.000005 SOL for fees: send a little SOL to Key111. Each round tries again, and nothing signed to you is lost meanwhile.');
  });

  it('does not say twice that what was signed is safe when the chain note already says it', () => {
    assert.equal(payoutFailedSentence({ at: Date.parse('2026-11-22T01:02:00Z'), said: 'Simulation failed; the node key has 0.000000 SOL for fees: send a little SOL to Key111. What routers signed is safe and is redeemed once the key can pay' }),
      'The last payout round, at 01:02 UTC, failed: Simulation failed; the node key has 0.000000 SOL for fees: send a little SOL to Key111. What routers signed is safe and is redeemed once the key can pay. Each round tries again.');
  });

  it('gives the webhook the same sentence, with the node, and the failure as JSON', () => {
    const f = { at: Date.parse('2026-11-22T12:34:56Z'), said: 'Simulation failed' };
    const n = payoutFailedNotice('Halo', f);
    assert.equal(n.text, `Halo: ${payoutFailedSentence(f)}`);
    assert.equal(n.content, n.text);
    assert.deepEqual(n.payoutFailed, { node: 'Halo', at: '2026-11-22T12:34:56.000Z', said: 'Simulation failed' });
  });

  it('orrery provider redeem: each channel paid, then the total, the wallet and how many transactions to check', () => {
    assert.deepEqual(redeemLines([{ channel: 'ChanA1111', amount: 300n, tx: 'TX1' }, { channel: 'ChanB2222', amount: 129n, tx: 'TX1' }, { channel: 'ChanC3333', amount: 0n, tx: 'TX1' }], 'Wallet1'), [
      '$0.000300 from channel ChanA1…  tx TX1',
      '$0.000129 from channel ChanB2…  tx TX1',
      '$0.000429 to your wallet Wallet1 in 1 transaction; orrery provider payouts checks it against the chain',
    ]);
    assert.deepEqual(redeemLines([], 'Wallet1'), ['nothing to redeem: no channel holds money signed to this node that is not paid out yet']);
  });

  it('says nothing when no round has failed since the last that went through', () => {
    assert.equal(payoutFailedSentence(null), '');
    assert.equal(payoutFailedSentence(undefined), '');
  });
});
