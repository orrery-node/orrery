import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { PublicKey } from '@solana/web3.js';
import { ed25519Verify, type Sign } from './keys.ts';

/** A node on the same network saying where it can be reached there: its listing, a URL on that network, and when,
 * signed with the node key on its listing. A router that hears it reads the listing on chain by address and, when the
 * node key on it signed this, sends that node's requests to the URL on the network instead of the one on chain. */
export type Beacon = { lan: 1; listing: string; url: string; at: number; sig: string };

/** How often a node says where it is, and how long a router keeps to what it heard. */
export const LAN_EVERY_MS = 15_000;
export const LAN_FRESH_MS = 2 * 60_000;
/** The port a router listens on and a node says where it is on, when neither names one. */
export const LAN_PORT = 7373;
const MAX_BYTES = 1_024;
/** How many listings a router keeps from its network at once: anything past that is dropped until one goes quiet. */
export const LAN_MAX_HEARD = 256;
const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The bytes a node key signs: a fixed prefix and the listing, URL and time in a fixed key order. */
export function beaconMessage(listing: string, url: string, at: number): Uint8Array {
  return Buffer.concat([Buffer.from('orrery/lan/1'), Buffer.from(JSON.stringify({ listing, url, at }))]);
}

export function signBeacon(listing: string, url: string, at: number, sign: Sign): Beacon {
  return { lan: 1, listing, url, at, sig: Buffer.from(sign(beaconMessage(listing, url, at))).toString('base64') };
}

/** A datagram read as a beacon, or null: anything else on the port is dropped without a word. */
export function parseBeacon(bytes: Buffer | string): Beacon | null {
  if (bytes.length > MAX_BYTES) return null;
  let j: Partial<Beacon>;
  try {
    j = JSON.parse(bytes.toString()) as Partial<Beacon>;
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || j.lan !== 1 || typeof j.listing !== 'string' || !base58.test(j.listing)) return null;
  if (typeof j.url !== 'string' || j.url.length > 200 || typeof j.at !== 'number' || !Number.isSafeInteger(j.at) || typeof j.sig !== 'string') return null;
  try {
    const u = new URL(j.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { lan: 1, listing: j.listing, url: j.url.replace(/\/$/, ''), at: j.at, sig: j.sig };
}

/** Whether the node key on the listing signed this beacon, and it is recent: a beacon copied and sent again later is
 * no longer believed after LAN_FRESH_MS. */
export function beaconSigned(b: Beacon, nodeKey: PublicKey, now = Date.now()): boolean {
  if (Math.abs(now - b.at) > LAN_FRESH_MS) return false;
  return ed25519Verify(nodeKey.toBytes(), beaconMessage(b.listing, b.url, b.at), Buffer.from(b.sig, 'base64'));
}

/** `[host:]port` for a router to listen on (any interface when no host is given), or `host:port` for a node to say
 * where it is to (a router's address, or the network's broadcast address). */
export function lanAddress(spec: string, fallbackHost: string | null): { host: string; port: number } {
  const m = /^(?:(.+):)?(\d{1,5})$/.exec(spec.trim());
  const host = m?.[1] ?? fallbackHost;
  const port = Number(m?.[2]);
  if (!m || !host || !Number.isInteger(port) || port < (fallbackHost ? 0 : 1) || port > 65_535) throw new Error(`${spec} is not ${fallbackHost ? '[host:]port' : 'host:port'} (for example ${fallbackHost ? '7373' : '192.168.1.255:7373'})`);
  return { host, port };
}

/** This computer's first address on a network outside itself, for the URL a node says it is at, or null when it has none. */
export function networkAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

/** What a node says on its network, as `orrery provider status` and its console show it. */
export type Announcing = { to: string; url: string; sent: number; at: number | null };

/** `orrery provider status`: where this node says it is on its network, to whom, and how many beacons went out. */
export function announceLine(a: Announcing, now = Date.now()): string {
  const last = a.at === null ? 'none sent yet' : `${a.sent} sent, the last ${Math.max(0, Math.round((now - a.at) / 1000))} s ago`;
  return `  on this network       saying where it is to ${a.to} every ${LAN_EVERY_MS / 1000} s, signed with the node key: routers there reach it at ${a.url} (${last})`;
}

/** What a router heard on its network: the latest beacon for each listing, with when it came. */
export class LanListener {
  private heard = new Map<string, Beacon>();
  private socket: Socket | null = null;
  /** Called when a listing is heard for the first time, or at a new URL. */
  onNew: ((b: Beacon) => void) | null = null;
  address: string | null = null;

  listen(spec: string): Promise<string> {
    const { host, port } = lanAddress(spec, '0.0.0.0');
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (bytes) => this.take(bytes));
    socket.on('error', () => undefined);
    this.socket = socket;
    return new Promise((done, fail) => {
      socket.once('error', fail);
      socket.bind(port, host, () => {
        socket.off('error', fail);
        const a = socket.address();
        this.address = `${a.address}:${a.port}`;
        done(this.address);
      });
    });
  }

  /** One datagram: a beacon that reads is kept (the newest for its listing), anything else is dropped. */
  take(bytes: Buffer | string, now = Date.now()): Beacon | null {
    const b = parseBeacon(bytes);
    if (!b || Math.abs(now - b.at) > LAN_FRESH_MS) return null;
    const prev = this.heard.get(b.listing);
    if (prev && prev.at >= b.at) return null;
    if (!prev && this.heard.size >= LAN_MAX_HEARD && this.fresh(now).length >= LAN_MAX_HEARD) return null;
    this.heard.set(b.listing, b);
    if (!prev || prev.url !== b.url) this.onNew?.(b);
    return b;
  }

  /** The beacons still recent enough to believe (their signatures are checked against the listing on chain later). */
  fresh(now = Date.now()): Beacon[] {
    for (const [k, b] of this.heard) if (Math.abs(now - b.at) > LAN_FRESH_MS) this.heard.delete(k);
    return [...this.heard.values()];
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

/** A node saying where it is on its network every LAN_EVERY_MS: to one router's address, or to the network's broadcast
 * address so every router on it hears. Returns a function that stops it. */
export function announce(spec: string, beacon: () => Beacon, every = LAN_EVERY_MS, onSent?: () => void): () => void {
  const { host, port } = lanAddress(spec, null);
  const loopback = host === 'localhost' || host.startsWith('127.');
  const socket = createSocket('udp4');
  socket.on('error', () => undefined);
  let timer: NodeJS.Timeout | null = null;
  const send = () => {
    const bytes = Buffer.from(JSON.stringify(beacon()));
    socket.send(bytes, port, host, (err) => {
      if (!err) onSent?.();
    });
  };
  socket.bind(0, loopback ? '127.0.0.1' : undefined, () => {
    if (host.endsWith('.255')) socket.setBroadcast(true);
    send();
    timer = setInterval(send, every);
    timer.unref?.();
  });
  socket.unref();
  return () => {
    if (timer) clearInterval(timer);
    socket.close();
  };
}
