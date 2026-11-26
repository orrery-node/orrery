import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { ACCOUNT, programId } from '../src/chain/program.ts';
import { nothingToReadLine, Registry, rpcLeftOutLine } from '../src/router/registry.ts';
import { foundThroughPeers, mapLine, peersReport, RECORD_LINE } from '../src/doctor.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('reads the listings in its own record when the RPC will not list the program and no peer names any', async () => {
    const [a, b] = [0, 1].map(() => Keypair.generate().publicKey);
    const home = join(mkdtempSync(join(tmpdir(), 'orrery-record-')), 'watched.json');
    writeFileSync(home, JSON.stringify({ [b.toBase58()]: { checks: 4, up: 4, since: 1 } }));
    let refuse = true;
    const conn = {
      getProgramAccounts: async () => { if (refuse) throw new Error('403'); return [{ pubkey: a, account: listing() }]; },
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => listing()),
    } as unknown as Connection;
    const reg = new Registry(conn, { allowDev: true, measurements: [] }, undefined, home);
    const list = async () => ((await (reg as unknown as { listings: () => Promise<{ pubkey: PublicKey }[]> }).listings()).map((x) => x.pubkey.toBase58()));
    assert.deepEqual(await list(), [b.toBase58()]);
    assert.equal(reg.discovery, 'record');
    assert.deepEqual([...reg.fromRecord], [b.toBase58()]);
    // The RPC lists the program again but leaves the recorded node out: it is kept, and counted apart from the peers'.
    refuse = false;
    assert.deepEqual(await list(), [a.toBase58(), b.toBase58()]);
    assert.equal(reg.discovery, 'chain');
    assert.equal(reg.rpcLeftOut, 0);
    assert.deepEqual([...reg.fromRecord], [b.toBase58()]);
    // Named by a peer as well: it counts as found through the peers.
    reg.peerListings = () => [b.toBase58()];
    await list();
    assert.deepEqual([...reg.throughPeers], [b.toBase58()]);
    assert.deepEqual([...reg.fromRecord], []);
    assert.equal(reg.rpcLeftOut, 1);
  });

  it('says the listings came from the router\'s own record, and counts the nodes only in it', () => {
    assert.equal(peersReport({ peers: [], relay: null, discovery: 'record' }).at(-1), RECORD_LINE);
    assert.deepEqual(foundThroughPeers([{ address: 'x', found: 'record' }, { address: 'y', found: 'record' }, { address: 'z', found: 'rpc' }]), ['  2 listings only in this router\u2019s own record of the nodes it watched before, read on chain']);
  });

  it('says where the map came from in one line', () => {
    assert.equal(mapLine([]), null);
    assert.equal(mapLine([{ address: 'a', found: 'rpc' }]), "the map: 1 listing, 1 in the RPC's list");
    assert.equal(mapLine([{ address: 'a', found: 'rpc' }, { address: 'b', found: 'rpc' }, { address: 'c', found: 'peers' }, { address: 'd', found: 'record' }]), "the map: 4 listings, 2 in the RPC's list, 1 from peers, 1 from this router's own record");
    assert.equal(mapLine([{ address: 'c', found: 'peers' }, { address: 'd' }]), "the map: 2 listings, 1 in the RPC's list, 1 from peers");
    assert.equal(mapLine([{ address: 'c', found: 'peers' }]), "the map: 1 listing, none in the RPC's list, 1 from peers");
    const report = peersReport({ peers: [], relay: null, discovery: 'chain', providers: [{ address: 'a', found: 'rpc' }, { address: 'c', found: 'peers' }] });
    assert.ok(report.includes("the map: 2 listings, 1 in the RPC's list, 1 from peers"));
  });

  it('tells a router with nothing to read how to get its first map, keeping what the RPC said', async () => {
    const reg = new Registry({ getProgramAccounts: async () => { throw new Error('403 getProgramAccounts is not served'); } } as unknown as Connection, { allowDev: true, measurements: [] });
    await assert.rejects(() => reg.refresh(), (e: Error) => e.message === nothingToReadLine('403 getProgramAccounts is not served'));
    assert.equal(nothingToReadLine('403 x'), "403 x; no peer router or record of this router names a listing yet, so there is nothing to read one by one. Start the router with --peer <url>#<key> to read another router's notes (orrery peers --check <url> reads it first), or use an RPC that serves getProgramAccounts");
  });
});
