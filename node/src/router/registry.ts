// What the router knows about the network: every Provider account on chain, plus the price manifest each node
// serves, kept only if its sha256 matches the hash the provider's wallet put on chain.
import { loadWatched, saveWatched, type Watched } from './watched.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pledgeKept, verifyReceipt, type BurnReceipt, type ParsedTx } from '../burn.ts';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ACCOUNT, decodeConfig, decodeProvider, pda, programId, TEE_KINDS, type ProviderAccount } from '../chain/program.ts';
import { firmwareFloor, verifySnp, type Firmware } from '../tee/snp.ts';
import { tdxFmspc, verifyTdx } from '../tee/tdx.ts';
import { fetchCrls } from '../tee/crl.ts';
import { fetchTcbInfo } from '../tee/tcb.ts';
import { ed25519Verify, home } from '../keys.ts';
import { insideMessage, wireMessage } from '../seal.ts';
import { checkManifest, manifestHash, type Manifest, type ModelOffer } from '../manifest.ts';
import { addLanNode, fetchNode, setLanNodes } from '../proxy.ts';
import { beaconSigned, type Beacon } from '../lan.ts';
import { readKnown } from '../known.ts';
import { drop } from '../sse.ts';

/** `vcek` is the chip's certificate (DER, base64) that an AMD SEV-SNP node serves next to its report. */
export type Attestation = { kind: number; measurement: string; enclaveKey: string; report: string; reportHash: string; vcek?: string };

export type ProviderEntry = {
  address: string;
  account: ProviderAccount;
  manifest: Manifest | null;
  problem: string | null;
  checkedAt: number;
  tee: { verified: boolean; dev: boolean; reason: string; enclaveKey: Buffer } | null;
  /** The node is on this router's own network: it said so on --lan-listen, signed with the node key on its listing, so
   * its requests go to `url` there and `listed` is the address on chain. Null or unset for a node reached as listed. */
  lan?: { url: string; listed: string } | null;
  /** What the node's /health last said about its model server; unset until checked or for nodes that do not say. */
  upstream?: 'up' | 'down';
  /** How long the node's /health took to answer, and when, at the last check that got an answer. */
  healthMs?: number;
  healthAt?: number;
  /** When this router's health checks of the node first went unanswered, until one is answered again. */
  unansweredAt?: number;
  /** The node's own encryption key for requests on the wire, kept only if the node key on chain signed it. Null when
   * the node has none (an older node); requests to it travel as plain JSON inside TLS. */
  wire?: Buffer | null;
  /** The node said (on /v1/wire, signed with its node key) that it reads the channel and the voucher from inside the
   * sealed body, now or at some earlier read by this router (see Registry.pins). */
  wireInside?: boolean;
  /** The node's burn pledge and how much of it this router has verified on chain itself. */
  burn?: { share: number; spent: bigint; burned: bigint; receipts: number; kept: number; checkedAt: number };
};

/** What this router asks of an enclave beyond a valid report: which images, how old the chip's firmware may be
 * (AMD: a floor you set; Intel: whether a platform Intel lists as out of date is still accepted). */
export type TeePolicy = { allowDev: boolean; measurements: string[]; minFirmware?: Firmware | null; allowOutdated?: boolean; verifier?: (a: Attestation, p: ProviderAccount) => Promise<boolean> };

/** A node's /v1/wire answer, read: the wire key if the node key on its listing signed it, and whether the node reads
 * payment inside the seal, which counts only with the node key's signature over that too. */
export function readWire(j: { key?: string; sig?: string; inside?: boolean; insideSig?: string }, nodeKey: PublicKey): { key: Buffer; inside: boolean } | null {
  const key = Buffer.from(j.key ?? '', 'hex'), sig = Buffer.from(j.sig ?? '', 'hex');
  if (key.length !== 32 || !ed25519Verify(nodeKey.toBytes(), wireMessage(key), sig)) return null;
  const insideSig = Buffer.from(j.insideSig ?? '', 'hex');
  return { key, inside: j.inside === true && insideSig.length === 64 && ed25519Verify(nodeKey.toBytes(), insideMessage(key), insideSig) };
}

/** The node keys a router keeps to (see Registry.pins), as saved in its pin file; empty when there is none or it cannot be read. */
export function readPins(path?: string): Set<string> {
  try {
    return new Set(path && existsSync(path) ? ((JSON.parse(readFileSync(path, 'utf8')) as { inside?: string[] }).inside ?? []) : []);
  } catch {
    return new Set();
  }
}

/** An RPC that will not list the program, and nothing else naming a listing yet: what failed, and how a router gets its
 * first map from another router. */
export function nothingToReadLine(why: string): string {
  return `${why}; no peer router or record of this router names a listing yet, so there is nothing to read one by one. Start the router with --peer <url>#<key> to read another router's notes (orrery peers --check <url> reads it first), or use an RPC that serves getProgramAccounts`;
}

/** Listings the RPC's list of the program left out that the peers named and the chain confirmed. */
export function rpcLeftOutLine(n: number): string {
  return `${n} listing${n === 1 ? '' : 's'} this RPC's list of the program left out, named by peer routers and read on chain one by one: the router uses ${n === 1 ? 'it' : 'them'} too`;
}

/** How often a router asks one node which other nodes it names (/orrery/known), and how many nodes it asks per refresh. */
export const KNOWN_EVERY_MS = 10 * 60_000;
export const KNOWN_READS = 32;

/** How long a node's address on this router's own network is passed over after it stopped answering there. */
export const LAN_DOWN_MS = 5 * 60_000;

export class Registry {
  entries = new Map<string, ProviderEntry>();
  /** Listing addresses peer routers named (their notes), for an RPC that will not list the program's accounts. */
  peerListings?: () => string[];
  /** How the last refresh found the listings: the program's accounts listed by the RPC, or the peers' addresses read
   * one by one and checked on chain. */
  discovery: 'chain' | 'peers' | 'record' | 'lan' | null = null;
  /** What nodes on this router's own network said (--lan-listen): where each listing can be reached there, believed only
   * with the signature of the node key on that listing. */
  lanBeacons?: () => Beacon[];
  /** The listings this router has only because a node on its own network named itself, read on chain by address. */
  fromLan = new Set<string>();
  /** The listings this router has only because a node it knows named them (/orrery/known), read on chain by address: a
   * node can point at listings, never make one up. */
  fromNodes = new Set<string>();
  /** What each node named at /orrery/known, and when it was asked. */
  private known = new Map<string, { at: number; named: string[] }>();
  /** Nodes whose address on this network stopped answering this router's health checks, with until when that address is
   * passed over: the node is reached as listed on chain meanwhile, whatever its beacons still say. */
  private lanDown = new Map<string, number>();
  /** Told when a node stops answering at its address on this network (the router logs it and refreshes soon). */
  onLanDown?: (e: ProviderEntry) => void;

  /** How long more a node's address on this network is passed over, in ms; 0 when it is not. */
  lanDownFor(address: string, now = Date.now()): number {
    return Math.max(0, (this.lanDown.get(address) ?? 0) - now);
  }
  /** Listings the RPC's list of the program left out that peer routers named and the chain confirmed: an RPC that drops a
   * listing (behind, or leaving it out) cannot hide a node the peers have seen. */
  rpcLeftOut = 0;
  /** The listings this router has only because peer routers named them: all of them when the RPC will not list the
   * program, the ones its list left out otherwise. */
  throughPeers = new Set<string>();
  /** The listings this router has only from its own record of the nodes it watched before (kept across restarts), not
   * from the RPC's list and not named by a peer: a node it has used does not vanish because an RPC stopped listing it. */
  fromRecord = new Set<string>();
  /** Addresses a peer named that the chain did not hold as a listing, with when to read them again: a closed listing a
   * peer still remembers costs one read every ten minutes, not one each refresh. */
  private absentUntil = new Map<string, number>();
  refreshedAt = 0;
  /** Node keys that have shown this router a signed wire key that reads payment inside. A router keeps to that: when the
   * flag or the wire key later goes missing (as a hosting platform in front of the node could make it), it keeps
   * payment inside, and it does not send that node a request in the clear. Kept in `pinPath` across restarts. */
  private pins = new Set<string>();

  constructor(private conn: Connection, private tee: TeePolicy, private pinPath?: string, private watchPath?: string) {
    // An unreadable file starts the pins over; they are filled again from the next signed answers.
    this.pins = readPins(pinPath);
    this.watch = loadWatched(watchPath);
  }

  /** Whether this node has shown this router a signed wire key that reads payment inside. */
  pinned(address: string): boolean {
    const e = this.entries.get(address);
    return !!e && this.pins.has(e.account.nodeKey.toBase58());
  }

  private pin(nodeKey: string): void {
    if (this.pins.has(nodeKey)) return;
    this.pins.add(nodeKey);
    if (!this.pinPath) return;
    mkdirSync(dirname(this.pinPath), { recursive: true });
    writeFileSync(this.pinPath, JSON.stringify({ inside: [...this.pins] }, null, 1));
  }

  async refresh(): Promise<void> {
    const accounts = await this.listings();
    const seen = new Set<string>();
    await Promise.all(
      accounts.map(async ({ pubkey, account }) => {
        const address = pubkey.toBase58();
        seen.add(address);
        let p: ProviderAccount;
        try {
          p = decodeProvider(account.data);
        } catch {
          return;
        }
        // A node on this router's own network is reached there: the same node (the manifest it serves there must still
        // match the hash on chain, and its wire key the node key's signature), only nearer.
        const listed = p.endpoint;
        const near = p.active ? this.lanUrl(address, p.nodeKey) : null;
        if (near) {
          addLanNode(near);
          p = { ...p, endpoint: near };
        }
        const prev = this.entries.get(address);
        const same = prev && prev.account.manifestHash.equals(p.manifestHash) && prev.account.endpoint === p.endpoint && prev.manifest && Date.now() - prev.checkedAt < 10 * 60_000;
        const entry: ProviderEntry = same ? { ...prev!, account: p } : { address, account: p, manifest: null, problem: null, checkedAt: Date.now(), tee: null };
        // A rebuilt entry keeps what this router last saw of the node's health while it is still at the same address: the
        // next health check is up to half a minute away, and a node known to be down must stay skipped until then.
        if (!same && prev && prev.account.endpoint === p.endpoint) {
          entry.upstream = prev.upstream;
          entry.healthMs = prev.healthMs;
          entry.healthAt = prev.healthAt;
          entry.unansweredAt = prev.unansweredAt;
        }
        if (!same && p.active) {
          try {
            const r = await fetchNode(`${p.endpoint.replace(/\/$/, '')}/v1/manifest`, { timeoutMs: 4_000 });
            const bytes = Buffer.from(await r.arrayBuffer());
            if (!manifestHash(bytes).equals(p.manifestHash)) throw new Error('manifest does not match the hash on chain');
            const m = checkManifest(JSON.parse(bytes.toString('utf8')));
            if (m.authority !== p.authority.toBase58()) throw new Error('manifest names another wallet');
            entry.manifest = m;
          } catch (err) {
            entry.problem = (err as Error).message;
          }
        }
        entry.lan = near ? { url: near, listed } : null;
        entry.tee = await this.checkTee(entry);
        // A node that showed a signed wire key before and has none now is asked again on every refresh, not only when
        // its listing changes: until then nothing goes to it in the clear.
        if (p.active && (!same || (!entry.wire && this.pins.has(p.nodeKey.toBase58())))) {
          const w = await this.wireKey(p, entry.manifest?.inside === true);
          entry.wire = w?.key ?? null;
          entry.wireInside = !!w?.inside;
        }
        this.entries.set(address, entry);
      }),
    );
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k);
    if (this.lanBeacons) setLanNodes([...this.entries.values()].flatMap((e) => (e.lan ? [e.lan.url] : [])));
    this.refreshedAt = Date.now();
  }

  /** Every listing on chain. Many RPCs refuse getProgramAccounts (it reads the whole program); when this one does and
   * peer routers have named listings, those addresses are read one by one (getMultipleAccountsInfo, which every RPC
   * serves) and each is kept only if the program owns it and it reads as a listing: a peer can point at listings,
   * never make one up. When the RPC does list the program, the listings the peers named that its list left out are read
   * the same way and added. The listings this router recorded before (its own record of the nodes it watched) are read
   * the same way too, so with no peers it still finds the nodes it knew. */
  private async listings(): Promise<readonly { pubkey: PublicKey; account: { data: Buffer } }[]> {
    let all: readonly { pubkey: PublicKey; account: { data: Buffer } }[];
    const peerNamed = this.named();
    const byPeers = new Set(peerNamed.map((k) => k.toBase58()));
    const lanNamed = this.lanNamed().filter((k) => !byPeers.has(k.toBase58()));
    const byLan = new Set(lanNamed.map((k) => k.toBase58()));
    const candidates = [...peerNamed, ...lanNamed, ...this.recorded().filter((k) => !byPeers.has(k.toBase58()) && !byLan.has(k.toBase58()))];
    const sort = (got: { pubkey: PublicKey }[]) => {
      this.throughPeers = new Set(got.map((x) => x.pubkey.toBase58()).filter((a) => byPeers.has(a)));
      this.fromLan = new Set(got.map((x) => x.pubkey.toBase58()).filter((a) => byLan.has(a)));
      this.fromRecord = new Set(got.map((x) => x.pubkey.toBase58()).filter((a) => !byPeers.has(a) && !byLan.has(a)));
    };
    this.fromNodes = new Set();
    try {
      all = await this.conn.getProgramAccounts(programId(), { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(ACCOUNT.Provider) } }] });
    } catch (e) {
      if (!candidates.length) throw new Error(nothingToReadLine((e as Error).message));
      const out = await this.readNamed(candidates);
      sort(out);
      this.discovery = this.throughPeers.size || (!this.fromLan.size && !this.fromRecord.size) ? 'peers' : this.fromLan.size ? 'lan' : 'record';
      this.rpcLeftOut = 0;
      return this.withNodesNamed(out);
    }
    this.discovery = 'chain';
    // The listings the RPC's list did not have are read by address, so one RPC is never the whole map.
    const have = new Set(all.map((a) => a.pubkey.toBase58()));
    const now = Date.now();
    const left = candidates.filter((k) => !have.has(k.toBase58()) && (this.absentUntil.get(k.toBase58()) ?? 0) <= now);
    const extra = left.length ? await this.readNamed(left).catch(() => null) : [];
    if (!extra) return this.withNodesNamed(all);
    if (left.length && extra.length < left.length) {
      const found = new Set(extra.map((x) => x.pubkey.toBase58()));
      for (const k of left) if (!found.has(k.toBase58())) this.absentUntil.set(k.toBase58(), now + 10 * 60_000);
    }
    sort(extra);
    this.rpcLeftOut = this.throughPeers.size;
    return this.withNodesNamed(extra.length ? [...all, ...extra] : all);
  }

  /** The listings found so far, and the ones the nodes among them name at /orrery/known that are not among them yet, each
   * read on chain by address. A node is asked at most every KNOWN_EVERY_MS, at most KNOWN_READS of them a refresh. */
  private async withNodesNamed(got: readonly { pubkey: PublicKey; account: { data: Buffer } }[]): Promise<readonly { pubkey: PublicKey; account: { data: Buffer } }[]> {
    const now = Date.now();
    const asked = got.flatMap(({ pubkey, account }) => {
      try {
        const p = decodeProvider(account.data);
        const address = pubkey.toBase58();
        return p.active ? [{ address, endpoint: this.entries.get(address)?.account.endpoint ?? p.endpoint }] : [];
      } catch {
        return [];
      }
    }).slice(0, KNOWN_READS);
    await Promise.all(asked.map(async ({ address, endpoint }) => {
      const k = this.known.get(address);
      if (k && now - k.at < KNOWN_EVERY_MS) return;
      const named = await fetchNode(`${endpoint.replace(/\/$/, '')}/orrery/known`, { timeoutMs: 3_000 }).then((r) => (r.ok ? r.json() : (drop(r), null))).then(readKnown).catch(() => [] as string[]);
      this.known.set(address, { at: now, named });
    }));
    const have = new Set(got.map((x) => x.pubkey.toBase58()));
    const fresh = [...new Set([...this.known.values()].flatMap((k) => k.named))].filter((a) => !have.has(a) && (this.absentUntil.get(a) ?? 0) <= now);
    if (!fresh.length) return got;
    const keys = fresh.flatMap((a) => { try { return [new PublicKey(a)]; } catch { return []; } });
    const more = await this.readNamed(keys).catch(() => null);
    if (!more) return got;
    const found = new Set(more.map((x) => x.pubkey.toBase58()));
    for (const a of fresh) if (!found.has(a)) this.absentUntil.set(a, now + 10 * 60_000);
    this.fromNodes = found;
    return [...got, ...more];
  }

  /** The listing addresses in this router's own record of the nodes it watched, each a valid key. */
  private recorded(): PublicKey[] {
    return [...this.watch.keys()].flatMap((a) => { try { return [new PublicKey(a)]; } catch { return []; } });
  }

  /** The listing addresses nodes on this router's own network named, each a valid key, once. */
  private lanNamed(): PublicKey[] {
    return [...new Set((this.lanBeacons?.() ?? []).map((b) => b.listing))].flatMap((a) => { try { return [new PublicKey(a)]; } catch { return []; } });
  }

  /** The URL on this router's own network a node said it is at, when the node key on its listing signed that and it is recent. */
  private lanUrl(address: string, nodeKey: PublicKey): string | null {
    if (this.lanDownFor(address) > 0) return null;
    const b = (this.lanBeacons?.() ?? []).find((x) => x.listing === address);
    return b && beaconSigned(b, nodeKey) ? b.url : null;
  }

  /** The listing addresses peer routers named, each a valid key, once. */
  private named(): PublicKey[] {
    return [...new Set(this.peerListings?.() ?? [])].flatMap((a) => { try { return [new PublicKey(a)]; } catch { return []; } });
  }

  /** Reads named addresses by address (getMultipleAccountsInfo, which every RPC serves) and keeps each only if the program
   * owns it and it reads as a listing: a peer can point at listings, never make one up. */
  private async readNamed(named: PublicKey[]): Promise<{ pubkey: PublicKey; account: { data: Buffer } }[]> {
    const out: { pubkey: PublicKey; account: { data: Buffer } }[] = [];
    for (let i = 0; i < named.length; i += 100) {
      const keys = named.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(keys);
      infos.forEach((info, j) => {
        if (info && info.owner.equals(programId()) && Buffer.from(info.data).subarray(0, ACCOUNT.Provider.length).equals(Buffer.from(ACCOUNT.Provider))) out.push({ pubkey: keys[j], account: { data: Buffer.from(info.data) } });
      });
    }
    return out;
  }

  /** The key a node wants requests encrypted to, accepted only with a signature from the node key on its listing. */
  /** Reads a node's wire key again, after the node said a request was encrypted to a key it no longer holds. */
  async refreshWire(address: string): Promise<void> {
    const e = this.entries.get(address);
    if (!e) return;
    const w = await this.wireKey(e.account, e.manifest?.inside === true);
    e.wire = w?.key ?? null;
    e.wireInside = !!w?.inside;
  }

  private async wireKey(p: ProviderAccount, listed = false): Promise<{ key: Buffer; inside: boolean } | null> {
    // Listed in the price list whose hash is on chain: kept to from the first request, before any /v1/wire answer.
    if (listed) this.pin(p.nodeKey.toBase58());
    try {
      const r = await fetchNode(`${p.endpoint.replace(/\/$/, '')}/v1/wire`, { timeoutMs: 4_000 });
      if (!r.ok) return null;
      const w = readWire((await r.json()) as Parameters<typeof readWire>[0], p.nodeKey);
      if (!w) return null;
      const nodeKey = p.nodeKey.toBase58();
      if (w.inside) this.pin(nodeKey);
      // Shown signed before and missing now: what changed is more likely the platform in front than the node.
      return this.pins.has(nodeKey) ? { key: w.key, inside: true } : w;
    } catch {
      return null;
    }
  }

  /** A provider's enclave counts only if the report it serves hashes to the on-chain claim, names the on-chain key,
   * is not expired, booted an allowed image, and the hardware verifier accepts it. Dev reports are software
   * stand-ins and pass only when the router is told to accept them for local testing. */
  private async checkTee(e: ProviderEntry): Promise<ProviderEntry['tee']> {
    const p = e.account;
    if (p.teeKind === 0 || !p.active) return null;
    const enclaveKey = Buffer.from(p.teeKey);
    if (BigInt(Math.floor(Date.now() / 1000)) >= p.teeExpiresAt) return { verified: false, dev: false, reason: 'attestation expired', enclaveKey };
    try {
      const r = await fetchNode(`${p.endpoint.replace(/\/$/, '')}/v1/attestation`, { timeoutMs: 4_000 });
      const a = (await r.json()) as Attestation;
      const report = Buffer.from(a.report, 'base64');
      if (!createHash('sha256').update(report).digest().equals(p.teeReportHash)) return { verified: false, dev: false, reason: 'report does not match the on-chain hash', enclaveKey };
      if (a.enclaveKey !== p.teeKey.toString('hex')) return { verified: false, dev: false, reason: 'report names another key', enclaveKey };
      if (this.tee.measurements.length && !this.tee.measurements.includes(p.teeMeasurement.toString('hex'))) return { verified: false, dev: false, reason: 'image not on your allow list', enclaveKey };
      let dev = false;
      try {
        dev = JSON.parse(report.toString('utf8')).dev === true;
      } catch {
        dev = false;
      }
      if (dev) return { verified: this.tee.allowDev, dev: true, reason: this.tee.allowDev ? 'dev report accepted (local testing)' : 'dev report, not hardware', enclaveKey };
      if (!this.tee.verifier) {
        // The built-in verifier: AMD SEV-SNP reports are and Intel TDX quotes are checked here against the chip makers' own roots, with no outside service.
        // The chip maker's revocation lists are read too (cached on disk for twelve hours); a revoked chip is refused.
        const crls = p.teeKind === 1 || p.teeKind === 2 ? await fetchCrls(p.teeKind === 2 ? 'amd' : 'intel', home('crl')).catch(() => [] as Buffer[]) : [];
        if (p.teeKind === 1) {
          // Intel's TCB list for the platform family says whether its microcode and TDX module are current; out of date is refused.
          const tcb = await fetchTcbInfo(tdxFmspc(report) ?? '', home('tcb')).catch(() => null);
          const v = verifyTdx({ quote: report, measurement: Buffer.from(p.teeMeasurement), enclaveKey, crls, tcb, allowOutdated: this.tee.allowOutdated });
          return { verified: v.ok, dev: false, reason: v.reason, enclaveKey };
        }
        if (p.teeKind !== 2) return { verified: false, dev: false, reason: `no built-in verifier for ${TEE_KINDS[p.teeKind] ?? 'this enclave kind'} yet`, enclaveKey };
        if (!a.vcek) return { verified: false, dev: false, reason: 'the node did not serve its chip certificate', enclaveKey };
        // --min-firmware 3.0.8.115 (or ORRERY_SNP_MIN_FIRMWARE) refuses AMD chips below that level; without it the level only has to be the chip key's own.
        const v = verifySnp({ report, vcek: Buffer.from(a.vcek, 'base64'), measurement: Buffer.from(p.teeMeasurement), enclaveKey, crls, minFirmware: firmwareFloor(this.tee.minFirmware, process.env.ORRERY_SNP_MIN_FIRMWARE) });
        return { verified: v.ok, dev: false, reason: v.reason, enclaveKey };
      }
      const ok = await this.tee.verifier(a, p);
      return { verified: ok, dev: false, reason: ok ? 'hardware report verified' : 'hardware verifier rejected the report', enclaveKey };
    } catch (err) {
      return { verified: false, dev: false, reason: `attestation fetch failed: ${(err as Error).message}`, enclaveKey };
    }
  }

  /** Asks every usable node's /health whether its model server answers, so the router can skip a node that is up
   * while its model is not, before paying for a request it cannot serve. A node that does not answer keeps its last
   * state; the router's own failure cool-down covers nodes that are down altogether. */
  /** This router's own record of every node it has checked, kept across registry refreshes and, when it has a home
   * folder, across restarts (router/watched.json). */
  private watch: Map<string, Watched>;

  watched(address: string): Watched | null {
    return this.watch.get(address) ?? null;
  }

  /** One request this router sent a node, and whether the node answered it: counted in the same record as the
   * health checks and written with it, so the count outlives the router. */
  noteRequest(address: string, answered: boolean): void {
    const now = Date.now();
    const rec = this.watch.get(address) ?? { checks: 0, up: 0, since: now };
    rec.askedSince ??= now;
    rec.sent = (rec.sent ?? 0) + 1;
    rec.answered = (rec.answered ?? 0) + (answered ? 1 : 0);
    this.watch.set(address, rec);
    if (this.watchPath) saveWatched(this.watchPath, this.watch);
  }

  async checkHealth(): Promise<void> {
    await Promise.all(
      this.usable().map(async (e) => {
        const t0 = Date.now();
        const rec = this.watch.get(e.address) ?? { checks: 0, up: 0, since: t0 };
        this.watch.set(e.address, rec);
        rec.checks += 1;
        const h = (await fetchNode(`${e.account.endpoint.replace(/\/$/, '')}/health`, { timeoutMs: 2_500 }).then((r) => (r.ok ? r.json() : (drop(r), null))).catch(() => null)) as { upstream?: string } | null;
        if (!h) {
          e.unansweredAt ??= Date.now();
          if (e.lan && !this.lanDownFor(e.address)) {
            this.lanDown.set(e.address, Date.now() + LAN_DOWN_MS);
            this.onLanDown?.(e);
          }
          return;
        }
        e.unansweredAt = undefined;
        if (h.upstream !== 'down') rec.up += 1;
        e.healthMs = Date.now() - t0;
        e.healthAt = Date.now();
        if (h.upstream === 'up' || h.upstream === 'down') e.upstream = h.upstream;
      }),
    );
    if (this.watchPath) saveWatched(this.watchPath, this.watch);
  }

  private burnSeen = new Map<string, { usdc: bigint; burned: bigint }>();

  /** For every node that pledged a burn: reads its receipts, then checks each buy and each burn on chain. Only what
   * the chain shows is counted, each transaction once, and `kept` compares it with what the pledge owes on the USDC
   * the provider's account says it has redeemed. */
  async checkBurns(usdcMint: PublicKey, mint: PublicKey): Promise<void> {
    const usedTx = new Map<string, string>();
    await Promise.all(
      this.usable().filter((e) => e.manifest?.burn).map(async (e) => {
        const share = e.manifest!.burn!.share;
        const owner = e.account.authority.toBase58();
        const j = (await fetchNode(`${e.account.endpoint.replace(/\/$/, '')}/orrery/burns`, { timeoutMs: 4_000 }).then((r) => (r.ok ? r.json() : (drop(r), null))).catch(() => null)) as { receipts?: BurnReceipt[] } | null;
        let spent = 0n, burned = 0n, n = 0;
        for (const r of (j?.receipts ?? []).slice(-200)) {
          if (typeof r?.swapTx !== 'string' || typeof r.burnTx !== 'string' || usedTx.has(r.swapTx) || usedTx.has(r.burnTx)) continue;
          usedTx.set(r.swapTx, e.address);
          usedTx.set(r.burnTx, e.address);
          const key = `${e.address}:${r.swapTx}:${r.burnTx}`;
          let v = this.burnSeen.get(key);
          if (!v) {
            const [swap, burn] = await Promise.all([r.swapTx, r.burnTx].map((sig) => this.conn.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)));
            if (!swap || !burn) continue;
            v = verifyReceipt(r, swap as ParsedTx, burn as ParsedTx, usdcMint.toBase58(), mint.toBase58(), owner);
            this.burnSeen.set(key, v);
          }
          if (v.burned > 0n) { spent += v.usdc; burned += v.burned; n++; }
        }
        e.burn = { share, spent, burned, receipts: n, kept: pledgeKept(e.account.settled, share, spent), checkedAt: Date.now() };
      }),
    );
  }

  private mints: { usdc: PublicKey; token: PublicKey } | null = null;

  /** `checkBurns` with the two mints read from the program's own config (the settlement mint and the network token). */
  async checkBurnsFromConfig(): Promise<void> {
    if (!this.mints) {
      const info = await this.conn.getAccountInfo(pda.config());
      if (!info) return;
      const c = decodeConfig(info.data);
      if (c.bondMint.equals(PublicKey.default)) return;
      this.mints = { usdc: c.settleMint, token: c.bondMint };
    }
    await this.checkBurns(this.mints.usdc, this.mints.token);
  }

  usable(): ProviderEntry[] {
    return [...this.entries.values()].filter((e) => e.account.active && e.manifest && !e.problem);
  }

  offers(model: string): { entry: ProviderEntry; offer: ModelOffer }[] {
    const out: { entry: ProviderEntry; offer: ModelOffer }[] = [];
    for (const e of this.usable()) {
      const offer = e.manifest!.models.find((m) => m.id === model);
      if (offer) out.push({ entry: e, offer });
    }
    return out;
  }

  catalog(): { id: string; providers: number; cheapest: ModelOffer['price']; cachedFrom: number | null; context: number; private: number; kind: ModelOffer['kind'] | null }[] {
    const by = new Map<string, { id: string; providers: number; cheapest: ModelOffer['price']; cachedFrom: number | null; context: number; private: number; kind: ModelOffer['kind'] | null }>();
    for (const e of this.usable()) {
      for (const m of e.manifest!.models) {
        const c = by.get(m.id) ?? { id: m.id, providers: 0, cheapest: m.price, cachedFrom: null, context: m.context, private: 0, kind: null };
        c.providers += 1;
        c.kind ??= m.kind ?? null;
        if (m.price.cachedInput !== undefined && (c.cachedFrom === null || m.price.cachedInput < c.cachedFrom)) c.cachedFrom = m.price.cachedInput;
        if (m.price.input + m.price.output < c.cheapest.input + c.cheapest.output) c.cheapest = m.price;
        c.context = Math.max(c.context, m.context);
        if (e.tee?.verified) c.private += 1;
        by.set(m.id, c);
      }
    }
    return [...by.values()].sort((a, b) => b.providers - a.providers || a.id.localeCompare(b.id));
  }

  get(address: string | PublicKey): ProviderEntry | undefined {
    return this.entries.get(typeof address === 'string' ? address : address.toBase58());
  }
}
