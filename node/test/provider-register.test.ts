import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fundKeyLamports, LISTING_BYTES, registerProblem } from '../src/provider/check.ts';

const base = { publicUrl: 'https://gpu.example.org', exists: false, lamports: 10_000_000, rent: 2_778_760, wallet: 'Wallet111' };

describe('orrery provider register, before it sends anything', () => {
  it('goes ahead when the address is set and the wallet can pay for the listing', () => {
    assert.equal(registerProblem(base), null);
    assert.equal(registerProblem({ ...base, exists: true, lamports: 20_000, rent: 0 }), null);
  });

  it('says how much SOL a listing takes when the wallet does not have it', () => {
    const said = registerProblem({ ...base, lamports: 0 });
    assert.match(said ?? '', /^your wallet Wallet111 has 0\.0000 SOL\. Listing a node takes about 0\.0028 SOL, once/);
    assert.match(said ?? '', /Send it a little SOL and run this again/);
    assert.match(registerProblem({ ...base, exists: true, lamports: 0, rent: 0 }) ?? '', /has 0\.0000 SOL\. Updating a listing is one transaction/);
  });

  it('refuses to list the placeholder address from provider init', () => {
    assert.match(registerProblem({ ...base, publicUrl: 'https://your-node.example.com' }) ?? '', /^set "publicUrl" first: it is still the placeholder from provider init/);
  });

  it('knows the size of a listing, which the rent is worked out from', () => {
    assert.equal(LISTING_BYTES, 419);
  });

  it('reads --fund-key as SOL for the node’s key: 0.01 with no amount, and nothing that looks like a slipped digit', () => {
    assert.equal(fundKeyLamports(undefined), 10_000_000);
    assert.equal(fundKeyLamports('0.02'), 20_000_000);
    assert.throws(() => fundKeyLamports('abc'), /--fund-key takes an amount of SOL, such as --fund-key 0\.01/);
    assert.throws(() => fundKeyLamports('0'), /--fund-key takes an amount of SOL/);
    assert.throws(() => fundKeyLamports('5'), /--fund-key 5 is more than a node key needs.*The most this sends is 0\.5 SOL/);
  });

  it('counts the key’s fee money in what the wallet must hold, and says so when it falls short', () => {
    assert.equal(registerProblem({ ...base, lamports: 2_778_760 + 10_000 + 10_000_000, fund: 10_000_000 }), null);
    const said = registerProblem({ ...base, lamports: 5_000_000, fund: 10_000_000 });
    assert.match(said ?? '', /Listing a node takes about 0\.0028 SOL, once: the rent for its listing on Solana, plus the fee\. --fund-key sends the node’s key another 0\.0100 SOL: 0\.0128 SOL in all\. Send it a little SOL and run this again$/);
    assert.match(registerProblem({ ...base, exists: true, rent: 0, lamports: 20_000, fund: 10_000_000 }) ?? '', /Updating a listing is one transaction and needs its fee\. --fund-key sends the node’s key another 0\.0100 SOL: 0\.0100 SOL in all\./);
  });
});
