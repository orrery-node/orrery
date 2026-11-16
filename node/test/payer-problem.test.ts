import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as channels from '../src/router/channels.ts';

const walletProblem = (channels as unknown as { walletProblem?: (o: { wallet: string | null; lamports: number; usdc: bigint; deposit: bigint }) => string | null }).walletProblem;

describe('why a router could not open a payment channel, when the reason is its own wallet', () => {
  it('says there is no wallet, and how to give it one: orrery wallet new, or --wallet for a keypair file', () => {
    assert.equal(typeof walletProblem, 'function', 'channels.ts explains a wallet problem');
    assert.equal(walletProblem!({ wallet: null, lamports: 0, usdc: 0n, deposit: 2_000_000n }), 'this router has no wallet, so it cannot open a payment channel. Make one with orrery wallet new and start the router again (it uses that wallet), or start it with orrery router --wallet <keypair.json> for a keypair file you have');
  });

  it('says what the wallet has and what a channel takes when it cannot pay', () => {
    assert.equal(walletProblem!({ wallet: 'Wallet111', lamports: 0, usdc: 0n, deposit: 2_000_000n }), 'your wallet Wallet111 has $0.00 USDC and 0.0000 SOL. Opening a channel locks $2.00 of USDC and takes about 0.005 SOL for rent and fees. Send it both and ask again');
    assert.match(walletProblem!({ wallet: 'Wallet111', lamports: 50_000_000, usdc: 500_000n, deposit: 2_000_000n }) ?? '', /^your wallet Wallet111 has \$0\.50 USDC and 0\.0500 SOL\. Opening a channel locks \$2\.00 of USDC/);
    assert.match(walletProblem!({ wallet: 'Wallet111', lamports: 1_000, usdc: 9_000_000n, deposit: 2_000_000n }) ?? '', /has \$9\.00 USDC and 0\.0000 SOL\./);
  });

  it('is silent when the wallet can pay: the failure was something else', () => {
    assert.equal(walletProblem!({ wallet: 'Wallet111', lamports: 50_000_000, usdc: 2_000_000n, deposit: 2_000_000n }), null);
  });

  it('says a deposit below the program’s minimum is why no channel opened, with the minimum and the flag to use', () => {
    const depositProblem = (channels as unknown as { depositProblem?: (deposit: bigint, min: bigint) => string | null }).depositProblem;
    assert.equal(typeof depositProblem, 'function', 'channels.ts explains a deposit below the minimum');
    assert.equal(depositProblem!(50_000n, 100_000n), 'a payment channel needs a deposit of at least $0.10 on this network and this router is set to $0.05, so it opened none. Start it with --deposit 0.1 or more; what you do not spend comes back when the channel closes');
    assert.equal(depositProblem!(100_000n, 100_000n), null);
    assert.equal(depositProblem!(2_000_000n, 100_000n), null);
  });
});
