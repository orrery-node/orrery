import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, type CheckLine } from '../src/provider/check.ts';

const L = (what: string, ok: boolean | null, detail = ''): CheckLine => ({ what, ok, detail });
const at = { config: 'provider.json', publicUrl: 'https://gpu.example.org', nodeKey: 'NodeKey111' };
const good = [L('model server', true), L('public address', true), L('listing', true), L('node key', true), L('data folder', true)];
const but = (what: string, ok: boolean | null, detail = '') => good.map((l) => (l.what === what ? L(what, ok, detail) : l));

describe('the one next step provider check ends with', () => {
  it('walks a new node through its first run in order', () => {
    const fresh = [L('model server', true), L('public address', false), L('listing', false, 'not on chain yet'), L('node key', false), L('data folder', true)];
    assert.match(nextStep(fresh, { ...at, publicUrl: 'https://your-node.example.com' }), /^next: set "publicUrl" in provider\.json to the address routers will reach/);
    assert.match(nextStep(fresh, at), /^next: list the node on chain: orrery provider register --config provider\.json --wallet <keypair\.json>/);
    assert.match(nextStep([L('model server', true), L('public address', false), L('listing', true), L('node key', false)], at), /^next: send a little SOL to NodeKey111 .*0\.01 SOL pays for about 2,000 payouts/);
    assert.match(nextStep(but('public address', false), at), /^next: start the node \(orrery provider start --config provider\.json, or provider compose for Docker\) and make sure https:\/\/gpu\.example\.org reaches it from outside/);
  });

  it('puts a model server that is not answering first, and a changed price list before anything after it', () => {
    assert.match(nextStep([L('model server', false, 'http://127.0.0.1:11434/v1 did not answer /models'), L('listing', false, 'not on chain yet')], at), /^next: start your model server: http:\/\/127\.0\.0\.1:11434\/v1 did not answer/);
    assert.match(nextStep(but('listing', false, 'your price list changed since you listed; run provider register again so routers accept it'), at), /^next: run orrery provider register --config provider\.json --wallet <keypair\.json> again: your price list changed/);
  });

  it('speaks to a node that is already running when its address does not answer', () => {
    assert.match(nextStep(but('public address', false), { ...at, running: true }), /^next: make sure https:\/\/gpu\.example\.org reaches this node from outside: it did not answer from here \(orrery provider check --config provider\.json looks again\)/);
    assert.match(nextStep([L('model server', true), L('public address', false), L('listing', false, 'not on chain yet'), L('node key', false)], { ...at, running: true }), /^next: list the node on chain: /);
  });

  it('says what listing costs when the check could read it', () => {
    const unlisted = (detail: string) => [L('model server', true), L('public address', true), L('listing', false, detail), L('node key', true)];
    assert.equal(nextStep(unlisted('not on chain yet: orrery provider register --config … --wallet … (takes about 0.0028 SOL once, the rent for the listing)'), at),
      'next: list the node on chain: orrery provider register --config provider.json --wallet <keypair.json> (one transaction from your wallet, about 0.0028 SOL once for the listing’s rent)');
    assert.equal(nextStep(unlisted('not on chain yet: orrery provider register --config … --wallet …'), at),
      'next: list the node on chain: orrery provider register --config provider.json --wallet <keypair.json> (a one-time transaction from your wallet)');
  });

  it('says ready when nothing fails, and names what is left when something else does', () => {
    assert.equal(nextStep(good, at), 'ready to earn: routers can find this node, reach it and pay it');
    assert.equal(nextStep(but('data folder', null, 'on a disk'), at), 'ready to earn: routers can find this node, reach it and pay it');
    assert.match(nextStep(but('data folder', false, '/tmp/x is a temporary folder'), at), /^next: data folder: \/tmp\/x is a temporary folder/);
  });

  it('leaves --wallet off the register line when the config names a wallet file that is there', () => {
    const unlisted = [L('model server', true), L('public address', true), L('listing', false, 'not on chain yet: orrery provider register --config …'), L('node key', true)];
    assert.equal(nextStep(unlisted, { ...at, walletInConfig: true }), 'next: list the node on chain: orrery provider register --config provider.json (a one-time transaction from your wallet)');
    assert.match(nextStep(unlisted, at), /register --config provider\.json --wallet <keypair\.json> /);
  });

  it('offers to send the node’s key its fee money in the register transaction, so there is one address to fund', () => {
    const fresh = [L('model server', true), L('public address', true), L('listing', false, 'not on chain yet: orrery provider register --config … lists it (takes about 0.0028 SOL once, the rent for the listing)'), L('node key', false, '0.0000 SOL for redeem fees')];
    assert.equal(nextStep(fresh, { ...at, walletInConfig: true }),
      'next: list the node on chain: orrery provider register --config provider.json --fund-key (one transaction from your wallet, about 0.0028 SOL once for the listing’s rent; --fund-key also sends the node’s key 0.01 SOL for redeem fees)');
    const listed = [L('model server', true), L('public address', true), L('listing', true), L('node key', false, '0.0000 SOL for redeem fees')];
    assert.equal(nextStep(listed, { ...at, walletInConfig: true }),
      'next: send a little SOL to NodeKey111 for redeem fees (0.01 SOL pays for about 2,000 payouts), or from the listing wallet: orrery provider register --config provider.json --fund-key');
  });

  it('sends the register step to the computer that has the wallet when this one only knows its address', () => {
    const unlisted = [L('model server', true), L('public address', true), L('listing', false, 'not on chain yet: orrery provider register --config … lists it'), L('node key', true)];
    assert.equal(nextStep(unlisted, { ...at, walletAway: '/home/you/.orrery/wallet.json' }),
      'next: list the node on chain, on the computer that has your wallet (/home/you/.orrery/wallet.json): orrery provider register --config provider.json (a one-time transaction from your wallet)');
    assert.equal(nextStep(unlisted, { ...at, walletAway: '' }),
      'next: list the node on chain, on the computer that has your wallet: orrery provider register --config provider.json --wallet <keypair.json> (a one-time transaction from your wallet)');
  });

  it('on a public cluster, says to change an address only your own network reaches before listing, and how to list it for your network anyway', () => {
    const lan = [L('model server', true), L('public address', null, 'http://192.168.1.20:7272 answered in 3 ms, but only machines on your network can reach that address'), L('listing', false, 'not on chain yet'), L('node key', false), L('data folder', true)];
    const atLan = { ...at, publicUrl: 'http://192.168.1.20:7272' };
    assert.equal(nextStep(lan, atLan), 'next: set "publicUrl" in provider.json to a public domain or IP with this node’s port open: http://192.168.1.20:7272 reaches only machines on your own network, so routers on the internet could not reach it (to list it for your own network anyway: orrery provider register --config provider.json --wallet <keypair.json> --private-address)');
    assert.match(nextStep(lan, { ...atLan, localCluster: true } as Parameters<typeof nextStep>[1]), /^next: list the node on chain: /, 'a local validator lists local addresses');
    assert.doesNotMatch(nextStep(good.map((l) => (l.what === 'public address' ? L('public address', null, 'only machines on your network') : l)), atLan), /set "publicUrl"/, 'a node already listed for its own network is not told again');
  });
});
