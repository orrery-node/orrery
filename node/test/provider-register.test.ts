import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LISTING_BYTES, registerProblem } from '../src/provider/check.ts';

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
});
