import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { signerOf } from '../src/keys.ts';
import { announce, announceLine, beaconSigned, lanAddress, lanFlag, LAN_FRESH_MS, LAN_MAX_HEARD, LAN_MAX_ROUTERS, LanListener, parseBeacon, parseRouterBeacon, routerBeaconSigned, signBeacon, signRouterBeacon, type Beacon } from '../src/lan.ts';
import { addLanNode, onLan, relayFor, setLanNodes, setNodeRelay } from '../src/proxy.ts';
import { lanLine } from '../src/router/server.ts';

const node = Keypair.generate();
const listing = Keypair.generate().publicKey.toBase58();
const sign = signerOf(node);

describe('a node saying where it is on its own network', () => {
  it('is believed only with the signature of the node key on its listing, and only while recent', () => {
    const now = Date.now();
    const b = signBeacon(listing, 'http://192.168.1.20:7070', now, sign);
    assert.ok(beaconSigned(b, node.publicKey, now));
    assert.ok(!beaconSigned(b, Keypair.generate().publicKey, now), 'another node key');
    assert.ok(!beaconSigned({ ...b, url: 'http://192.168.1.66:7070' }, node.publicKey, now), 'the URL changed on the way');
    assert.ok(!beaconSigned({ ...b, listing: Keypair.generate().publicKey.toBase58() }, node.publicKey, now), 'another listing');
    assert.ok(!beaconSigned(b, node.publicKey, now + LAN_FRESH_MS + 1), 'sent again too late');
  });

  it('reads only well-formed beacons off the port', () => {
    const b = signBeacon(listing, 'http://192.168.1.20:7070/', Date.now(), sign);
    assert.equal(parseBeacon(JSON.stringify(b))?.url, 'http://192.168.1.20:7070');
    assert.equal(parseBeacon('not json'), null);
    assert.equal(parseBeacon(JSON.stringify({ ...b, lan: 2 })), null);
    assert.equal(parseBeacon(JSON.stringify({ ...b, url: 'file:///etc/passwd' })), null);
    assert.equal(parseBeacon(JSON.stringify({ ...b, listing: 'x' })), null);
    assert.equal(parseBeacon(JSON.stringify({ ...b, pad: 'x'.repeat(1_100) })), null);
  });

  it('takes [host:]port to listen on and host:port to say it to', () => {
    assert.deepEqual(lanAddress('7373', '0.0.0.0'), { host: '0.0.0.0', port: 7373 });
    assert.deepEqual(lanAddress('127.0.0.1:7373', '0.0.0.0'), { host: '127.0.0.1', port: 7373 });
    assert.deepEqual(lanAddress('192.168.1.255:7373', null), { host: '192.168.1.255', port: 7373 });
    assert.throws(() => lanAddress('7373', null), /host:port/);
    assert.throws(() => lanAddress('127.0.0.1:99999', '0.0.0.0'));
  });

  it('reads a LAN flag that stands alone as its default, and one that needs an address says so', () => {
    assert.equal(lanFlag(['router', '--lan-listen', '--lan-peers'], 'lan-listen', '7373'), '7373');
    assert.equal(lanFlag(['router', '--lan-listen'], 'lan-listen', '7373'), '7373');
    assert.equal(lanFlag(['router', '--lan-listen', '127.0.0.1:7400', '--lan-peers'], 'lan-listen', '7373'), '127.0.0.1:7400');
    assert.equal(lanFlag(['router', '--lan-peers'], 'lan-listen', '7373'), undefined);
    assert.throws(() => lanFlag(['provider', 'start', '--lan-announce', '--lan-url', 'http://x'], 'lan-announce', null), /--lan-announce needs host:port/);
    assert.equal(lanFlag(['provider', 'start', '--lan-announce', '192.168.1.255:7373'], 'lan-announce', null), '192.168.1.255:7373');
  });

  it('a router keeps the newest beacon for each listing and is told when one is new or moved', () => {
    const lan = new LanListener();
    const told: string[] = [];
    lan.onNew = (b) => told.push(b.url);
    const now = Date.now();
    assert.ok(lan.take(JSON.stringify(signBeacon(listing, 'http://192.168.1.20:7070', now - 2_000, sign)), now));
    assert.equal(lan.take(JSON.stringify(signBeacon(listing, 'http://192.168.1.20:7070', now - 3_000, sign)), now), null, 'an older one');
    assert.ok(lan.take(JSON.stringify(signBeacon(listing, 'http://192.168.1.20:7070', now - 1_000, sign)), now));
    assert.ok(lan.take(JSON.stringify(signBeacon(listing, 'http://192.168.1.21:7070', now, sign)), now));
    assert.equal(lan.take(JSON.stringify(signBeacon(listing, 'http://192.168.1.20:7070', now - LAN_FRESH_MS - 1, sign)), now), null, 'too old to keep');
    assert.deepEqual(told, ['http://192.168.1.20:7070', 'http://192.168.1.21:7070']);
    assert.equal(lan.fresh(now).length, 1);
    assert.equal(lan.fresh(now + LAN_FRESH_MS + 1).length, 0);
  });

  it('a router keeps at most LAN_MAX_HEARD listings from its network at once', () => {
    const lan = new LanListener();
    const now = Date.now();
    for (let i = 0; i < LAN_MAX_HEARD + 20; i++) lan.take(JSON.stringify(signBeacon(Keypair.generate().publicKey.toBase58(), `http://10.0.0.${i % 250}:7070`, now, sign)), now);
    assert.equal(lan.fresh(now).length, LAN_MAX_HEARD);
    assert.ok(lan.take(JSON.stringify(signBeacon(listing, 'http://192.168.1.20:7070', now + LAN_FRESH_MS + 10, sign)), now + LAN_FRESH_MS + 10), 'room again once the others went quiet');
  });

  it('a node\'s beacon reaches a router listening on this computer', async () => {
    const lan = new LanListener();
    const at = await lan.listen('127.0.0.1:0');
    const heard = new Promise<Beacon>((done) => (lan.onNew = done));
    const stop = announce(at, () => signBeacon(listing, 'http://127.0.0.1:7070', Date.now(), sign), 60_000);
    const b = await heard;
    stop();
    lan.close();
    assert.equal(b.listing, listing);
    assert.ok(beaconSigned(b, node.publicKey));
  });

  it('a node on the network is reached directly, never through a peer relay', () => {
    setNodeRelay({ host: '10.0.0.9', port: 7272, label: 'http://10.0.0.9:7272' } as never);
    setLanNodes(['http://192.168.1.20:7070']);
    assert.ok(onLan('http://192.168.1.20:7070/v1/chat/completions'));
    assert.equal(relayFor('http://192.168.1.20:7070'), null);
    assert.equal(relayFor('https://node.example:443')?.port, 7272);
    addLanNode('http://192.168.1.21:7070');
    assert.equal(relayFor('http://192.168.1.21:7070/v1/manifest'), null, 'marked direct before its price list is read');
    setLanNodes([]);
    setNodeRelay(null);
    assert.ok(!onLan('http://192.168.1.20:7070'));
  });

  it('orrery provider status says where the node says it is, to whom, and how many beacons went out', () => {
    assert.equal(announceLine({ to: '192.168.1.255:7373', url: 'http://192.168.1.20:7070', sent: 0, at: null }), '  on this network       saying where it is to 192.168.1.255:7373 every 15 s, signed with the node key: routers there reach it at http://192.168.1.20:7070 (none sent yet)');
    assert.equal(announceLine({ to: '192.168.1.255:7373', url: 'http://192.168.1.20:7070', sent: 4, at: 1_000 }, 13_400), '  on this network       saying where it is to 192.168.1.255:7373 every 15 s, signed with the node key: routers there reach it at http://192.168.1.20:7070 (4 sent, the last 12 s ago)');
  });

  it('a node counts the beacons it sent', async () => {
    const lan = new LanListener();
    const at = await lan.listen('127.0.0.1:0');
    let sent = 0;
    const heard = new Promise<Beacon>((done) => (lan.onNew = done));
    const stop = announce(at, () => signBeacon(listing, 'http://127.0.0.1:7070', Date.now(), sign), 60_000, () => sent++);
    await heard;
    stop();
    lan.close();
    assert.equal(sent, 1);
  });

  it('a router on the network says where its notes are, believed only with the signature of the key it names', () => {
    const router = Keypair.generate();
    const key = router.publicKey.toBase58();
    const now = Date.now();
    const b = signRouterBeacon(key, 'http://192.168.1.30:7171', now, signerOf(router));
    assert.ok(routerBeaconSigned(b, now));
    assert.ok(!routerBeaconSigned({ ...b, url: 'http://192.168.1.66:7171' }, now), 'the URL changed on the way');
    assert.ok(!routerBeaconSigned(signRouterBeacon(key, 'http://192.168.1.30:7171', now, sign), now), 'signed with another key');
    assert.ok(!routerBeaconSigned(b, now + LAN_FRESH_MS + 1), 'too old');
    assert.equal(parseRouterBeacon(JSON.stringify(b))?.router, key);
    assert.equal(parseBeacon(JSON.stringify(b)), null, 'not a node beacon');
    assert.equal(parseRouterBeacon(JSON.stringify({ ...b, url: 'ftp://x' })), null);
  });

  it('a router keeps the routers it heard on its network, newest beacon each, forged ones dropped, at most LAN_MAX_ROUTERS', () => {
    const lan = new LanListener();
    const now = Date.now();
    const r = Keypair.generate();
    lan.take(JSON.stringify(signRouterBeacon(r.publicKey.toBase58(), 'http://192.168.1.30:7171', now - 2_000, signerOf(r))), now);
    lan.take(JSON.stringify(signRouterBeacon(r.publicKey.toBase58(), 'http://192.168.1.31:7171', now - 1_000, signerOf(r))), now);
    lan.take(JSON.stringify(signRouterBeacon(Keypair.generate().publicKey.toBase58(), 'http://192.168.1.40:7171', now, sign)), now);
    assert.deepEqual(lan.routersHeard(now).map((x) => x.url), ['http://192.168.1.31:7171']);
    assert.equal(lan.fresh(now).length, 0, 'a router is not a listing');
    for (let i = 0; i < LAN_MAX_ROUTERS + 5; i++) { const k = Keypair.generate(); lan.take(JSON.stringify(signRouterBeacon(k.publicKey.toBase58(), `http://10.0.1.${i}:7171`, now, signerOf(k))), now); }
    assert.equal(lan.routersHeard(now).length, LAN_MAX_ROUTERS);
  });

  it('a router is told when another router is heard on its network for the first time or at a new address', () => {
    const lan = new LanListener();
    const told: string[] = [];
    lan.onRouter = (b) => told.push(b.url);
    const r = Keypair.generate();
    const now = Date.now();
    lan.take(JSON.stringify(signRouterBeacon(r.publicKey.toBase58(), 'http://192.168.1.30:7171', now - 2_000, signerOf(r))), now);
    lan.take(JSON.stringify(signRouterBeacon(r.publicKey.toBase58(), 'http://192.168.1.30:7171', now - 1_000, signerOf(r))), now);
    lan.take(JSON.stringify(signRouterBeacon(r.publicKey.toBase58(), 'http://192.168.1.31:7171', now, signerOf(r))), now);
    assert.deepEqual(told, ['http://192.168.1.30:7171', 'http://192.168.1.31:7171']);
  });

  it('the router says once where a node on its network is reached', () => {
    assert.equal(lanLine('Kestrel GPU Co-op', 'http://192.168.1.20:7070', 'https://kestrel.example'), 'Kestrel GPU Co-op is on this network: its requests go to http://192.168.1.20:7070 directly (listed on chain at https://kestrel.example), checked by the node key on its listing');
  });
});
