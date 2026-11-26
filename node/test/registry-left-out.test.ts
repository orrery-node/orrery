import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { ACCOUNT, programId } from '../src/chain/program.ts';
import { Registry, rpcLeftOutLine } from '../src/router/registry.ts';
import { foundThroughPeers, peersReport } from '../src/doctor.ts';

const listing = () => ({ owner: programId(), data: Buffer.concat([Buffer.from(ACCOUNT.Provider), Buffer.alloc(8)]) });

describe('peer exchange past an RPC that leaves listings out', () => {
  it('adds the listings the peers named that the RPC list left out, each read on chain, and drops what the chain does not hold', async () => {
    const [a, b, c] = [0, 1, 2].map(() => Keypair.generate().publicKey);
    const asked: string[][] = [];
    const conn = {
      getProgramAccounts: async () => [{ pubkey: a, account: listing() }],
      getMultipleAccountsInfo: async (keys: PublicKey[]) => { asked.push(keys.map((k) => k.toBase58())); return keys.map((k) => (k.equals(b) ? listing() : null)); },
    } as unknown as Connection;
    const reg = new Registry(conn, { allowDev: true, measurements: [] });
    reg.peerListings = () => [a.toBase58(), b.toBase58(), c.toBase58(), b.toBase58(), 'not a key'];
    const list = async () => ((await (reg as unknown as { listings: () => Promise<{ pubkey: PublicKey }[]> }).listings()).map((x) => x.pubkey.toBase58()));
    assert.deepEqual(await list(), [a.toBase58(), b.toBase58()]);
    assert.equal(reg.discovery, 'chain');
    assert.equal(reg.rpcLeftOut, 1);
    assert.deepEqual(asked, [[b.toBase58(), c.toBase58()]]);
    // The address the chain did not hold is not read again on the next refresh; the one it did is.
    assert.deepEqual(await list(), [a.toBase58(), b.toBase58()]);
    assert.deepEqual(asked[1], [b.toBase58()]);
  });

  it('reads nothing extra when the RPC list already has every listing the peers named', async () => {
    const a = Keypair.generate().publicKey;
    let reads = 0;
    const conn = { getProgramAccounts: async () => [{ pubkey: a, account: listing() }], getMultipleAccountsInfo: async () => { reads++; return []; } } as unknown as Connection;
    const reg = new Registry(conn, { allowDev: true, measurements: [] });
    reg.peerListings = () => [a.toBase58()];
    await (reg as unknown as { listings: () => Promise<unknown> }).listings();
    assert.equal(reads, 0);
    assert.equal(reg.rpcLeftOut, 0);
  });

  it('keeps the RPC list when reading the named addresses fails, and tries them again on the next refresh', async () => {
    const [a, b] = [0, 1].map(() => Keypair.generate().publicKey);
    let fail = true;
    const conn = {
      getProgramAccounts: async () => [{ pubkey: a, account: listing() }],
      getMultipleAccountsInfo: async (keys: PublicKey[]) => { if (fail) throw new Error('429'); return keys.map(() => listing()); },
    } as unknown as Connection;
    const reg = new Registry(conn, { allowDev: true, measurements: [] });
    reg.peerListings = () => [b.toBase58()];
    const list = async () => ((await (reg as unknown as { listings: () => Promise<{ pubkey: PublicKey }[]> }).listings()).map((x) => x.pubkey.toBase58()));
    assert.deepEqual(await list(), [a.toBase58()]);
    fail = false;
    assert.deepEqual(await list(), [a.toBase58(), b.toBase58()]);
    assert.equal(reg.rpcLeftOut, 1);
  });

  it('says how many in orrery peers and in the log line', () => {
    assert.equal(rpcLeftOutLine(1), "1 listing this RPC's list of the program left out, named by peer routers and read on chain one by one: the router uses it too");
    assert.equal(rpcLeftOutLine(3), "3 listings this RPC's list of the program left out, named by peer routers and read on chain one by one: the router uses them too");
    assert.equal(peersReport({ peers: [], relay: null, discovery: 'chain', rpcLeftOut: 2 }).at(-1), rpcLeftOutLine(2));
    assert.ok(!peersReport({ peers: [], relay: null, discovery: 'chain', rpcLeftOut: 0 }).some((l) => l.includes('left out')));
  });

  it('remembers which listings came only through the peers, and forgets them when the RPC lists them again', async () => {
    const [a, b] = [0, 1].map(() => Keypair.generate().publicKey);
    let full = false;
    const conn = {
      getProgramAccounts: async () => (full ? [{ pubkey: a, account: listing() }, { pubkey: b, account: listing() }] : [{ pubkey: a, account: listing() }]),
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => listing()),
    } as unknown as Connection;
    const reg = new Registry(conn, { allowDev: true, measurements: [] });
    reg.peerListings = () => [b.toBase58()];
    const list = (reg as unknown as { listings: () => Promise<unknown> }).listings.bind(reg);
    await list();
    assert.deepEqual([...reg.throughPeers], [b.toBase58()]);
    full = true;
    await list();
    assert.deepEqual([...reg.throughPeers], []);
  });

  it('lists the nodes found through peers with how many peer routers named each, at most ten', () => {
    const rows = [
      { address: 'AAAAbbbbccccddddeeeeffffgggghhhhiiii1111', name: 'Beacon Lanes', found: 'peers', peers: { routers: 2 } },
      { address: 'BBBBbbbbccccddddeeeeffffgggghhhhiiii2222', name: null, found: 'peers', peers: { routers: 1 } },
      { address: 'CCCCbbbbccccddddeeeeffffgggghhhhiiii3333', name: 'Orrery Seed', found: 'rpc', peers: null },
    ];
    assert.deepEqual(foundThroughPeers(rows), [
      '  Beacon Lanes (AAAA\u20261111): found through peers, named by 2 peer routers, read on chain',
      '  BBBBbbbbccccddddeeeeffffgggghhhhiiii2222: found through peers, named by 1 peer router, read on chain',
    ]);
    assert.deepEqual(foundThroughPeers([]), []);
    const many = Array.from({ length: 12 }, (_, i) => ({ address: `node${i}`, found: 'peers', peers: { routers: 1 } }));
    assert.equal(foundThroughPeers(many).length, 11);
    assert.equal(foundThroughPeers(many).at(-1), '  and 2 more found through peers');
    assert.deepEqual(peersReport({ peers: [], relay: null, discovery: 'chain', rpcLeftOut: 1, providers: rows.slice(0, 1) }).slice(-2), [rpcLeftOutLine(1), foundThroughPeers(rows.slice(0, 1))[0]]);
  });
});
