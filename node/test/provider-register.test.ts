import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as check from '../src/provider/check.ts';
import { fundKeyLamports, fundKeyNote, LISTING_BYTES, nodeKeyLine, registerProblem } from '../src/provider/check.ts';
import { feesLine, payoutFailureNote } from '../src/provider/node.ts';

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

  it('counts the rent of the wallet’s USDC account in what the node key needs, when the first payout has to open it', () => {
    assert.deepEqual(nodeKeyLine({ lamports: 3_000_000, accountRent: null, nodeKey: 'Key111' }), { ok: true, what: 'node key', detail: '0.0030 SOL for redeem fees' });
    const short = nodeKeyLine({ lamports: 3_000_000, accountRent: 2_039_280, nodeKey: 'Key111' });
    assert.equal(short.ok, false);
    assert.match(short.detail, /^0\.0030 SOL for redeem fees; the first payout also opens your wallet’s USDC account, about 0\.0020 SOL once from this key; send a little to Key111 /);
    const enough = nodeKeyLine({ lamports: 10_000_000, accountRent: 2_039_280, nodeKey: 'Key111' });
    assert.equal(enough.ok, true);
    assert.equal(enough.detail, '0.0100 SOL for redeem fees; the first payout also opens your wallet’s USDC account, about 0.0020 SOL once from this key');
  });

  it('says what 0.01 SOL pays for when the first payout must open the USDC account: that, and the payouts left after it', () => {
    assert.match(nodeKeyLine({ lamports: 0, accountRent: 1_488_440, nodeKey: 'Key111' }).detail, /\(0\.01 SOL pays for that and about 1,700 payouts\)/, 'mainnet rent');
    assert.match(nodeKeyLine({ lamports: 0, accountRent: 2_039_280, nodeKey: 'Key111' }).detail, /\(0\.01 SOL pays for that and about 1,600 payouts\)/, 'local validator rent');
    assert.match(nodeKeyLine({ lamports: 0, accountRent: null, nodeKey: 'Key111' }).detail, /\(0\.01 SOL pays for about 2,000 payouts\)/, 'nothing to open');
  });

  it('says how many payouts --fund-key pays for, after the one that opens the wallet’s USDC account', () => {
    assert.equal(fundKeyNote(10_000_000, 'Key111', null), 'sent 0.0100 SOL to the node’s key Key111 for redeem fees (about 2,000 payouts)');
    assert.equal(fundKeyNote(10_000_000, 'Key111', 2_039_280), 'sent 0.0100 SOL to the node’s key Key111 for redeem fees (about 1,592 payouts; the first also opens your wallet’s USDC account)');
  });

  it('says why a first payout failed when the key could not also open the wallet’s USDC account', () => {
    assert.equal(payoutFailureNote({ lamports: 1_000_000, openingRent: 2_039_280, nodeKey: 'Key111' }),
      '; the first payout also opens your wallet’s USDC account, which takes about 0.0020 SOL from the node key, and it has 0.0010 SOL: send a little SOL to Key111. What routers signed is safe and is redeemed once the key can pay');
    assert.match(payoutFailureNote({ lamports: 5_000, openingRent: null, nodeKey: 'Key111' }), /^; the node key has 0\.000005 SOL for fees: send a little SOL to Key111\. What routers signed is safe/);
    assert.equal(payoutFailureNote({ lamports: 50_000_000, openingRent: null, nodeKey: 'Key111' }), '');
    assert.equal(payoutFailureNote({ lamports: 50_000_000, openingRent: 2_039_280, nodeKey: 'Key111' }), '');
  });

  it('counts the payout that opens the wallet’s USDC account in what the fee money covers', () => {
    assert.equal(feesLine({ lamports: 10_000_000, openingRent: null, nodeKey: 'Key111' }), '0.0100 SOL on the node key, about 2,000 payouts');
    assert.equal(feesLine({ lamports: 10_000_000, openingRent: 2_039_280, nodeKey: 'Key111' }), '0.0100 SOL on the node key, about 1,592 payouts; the first also opens your wallet’s USDC account');
    assert.match(feesLine({ lamports: 1_000_000, openingRent: 2_039_280, nodeKey: 'Key111' }), /about 0 payouts; the first also opens your wallet’s USDC account; running low, send a little SOL to Key111$/);
  });

  it('tells an address only machines on your own network can reach from one routers on the internet can', () => {
    const privateAddress = (check as unknown as { privateAddress?: (url: string) => boolean }).privateAddress;
    assert.equal(typeof privateAddress, 'function', 'check.ts tells private addresses apart');
    for (const u of ['http://127.0.0.1:7272', 'http://localhost:7272', 'https://10.0.0.5', 'http://172.16.4.2:7272', 'http://172.31.255.1', 'http://192.168.1.20:7272', 'http://169.254.10.1', 'http://100.101.102.103:7272', 'http://0.0.0.0:7272', 'http://gpu-box.local:7272', 'http://[::1]:7272', 'http://[fd12:3456::1]:7272', 'http://[fe80::1]:7272'])
      assert.equal(privateAddress!(u), true, u);
    for (const u of ['https://gpu.example.org', 'http://203.0.113.7:7272', 'http://172.32.0.1', 'http://100.128.0.1', 'https://[2001:db8::1]:7272', 'not a url'])
      assert.equal(privateAddress!(u), false, u);
  });

  it('sends nothing to list a node on a public cluster under an address only your own network can reach, and says how to fix it', () => {
    const said = registerProblem({ ...base, publicUrl: 'http://192.168.1.20:7272' } as Parameters<typeof registerProblem>[0]) ?? '';
    assert.equal(said, '"publicUrl" is http://192.168.1.20:7272, an address only machines on your own network can reach, so routers on the internet could not reach the node you would list. Set it to a public domain or IP with the node’s port open, or pass --private-address to list it for routers on your network only');
    assert.equal(registerProblem({ ...base, publicUrl: 'http://192.168.1.20:7272', localCluster: true } as Parameters<typeof registerProblem>[0]), null, 'a local validator lists local addresses');
    assert.equal(registerProblem({ ...base, publicUrl: 'http://192.168.1.20:7272', privateOk: true } as Parameters<typeof registerProblem>[0]), null, '--private-address lists it anyway');
    assert.match(registerProblem({ ...base, publicUrl: 'http://127.0.0.1:7272', lamports: 0 } as Parameters<typeof registerProblem>[0]) ?? '', /only machines on your own network/, 'the address is said before the money');
  });
});
