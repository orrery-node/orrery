// What the router knows about the network: every Provider account on chain, plus the price manifest each node
// serves, kept only if its sha256 matches the hash the provider's wallet put on chain.
import { createHash } from 'node:crypto';
import { pledgeKept, verifyReceipt, type BurnReceipt, type ParsedTx } from '../burn.ts';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ACCOUNT, decodeConfig, decodeProvider, pda, programId, TEE_KINDS, type ProviderAccount } from '../chain/program.ts';
import { firmwareFloor, verifySnp, type Firmware } from '../tee/snp.ts';
import { tdxFmspc, verifyTdx } from '../tee/tdx.ts';
import { fetchCrls } from '../tee/crl.ts';
import { fetchTcbInfo } from '../tee/tcb.ts';
import { ed25519Verify, home } from '../keys.ts';
import { wireMessage } from '../seal.ts';
import { checkManifest, manifestHash, type Manifest, type ModelOffer } from '../manifest.ts';
import { fetchNode } from '../proxy.ts';

/** `vcek` is the chip's certificate (DER, base64) that an AMD SEV-SNP node serves next to its report. */
export type Attestation = { kind: number; measurement: string; enclaveKey: string; report: string; reportHash: string; vcek?: string };

export type ProviderEntry = {
  address: string;
  account: ProviderAccount;
  manifest: Manifest | null;
  problem: string | null;
  checkedAt: number;
  tee: { verified: boolean; dev: boolean; reason: string; enclaveKey: Buffer } | null;
  /** What the node's /health last said about its model server; unset until checked or for nodes that do not say. */
  upstream?: 'up' | 'down';
  /** How long the node's /health took to answer, and when, at the last check that got an answer. */
  healthMs?: number;
  healthAt?: number;
  /** The node's own encryption key for requests on the wire, kept only if the node key on chain signed it. Null when
   * the node has none (an older node); requests to it travel as plain JSON inside TLS. */
  wire?: Buffer | null;
  /** The node's burn pledge and how much of it this router has verified on chain itself. */
  burn?: { share: number; spent: bigint; burned: bigint; receipts: number; kept: number; checkedAt: number };
};

/** What this router asks of an enclave beyond a valid report: which images, how old the chip's firmware may be
 * (AMD: a floor you set; Intel: whether a platform Intel lists as out of date is still accepted). */
export type TeePolicy = { allowDev: boolean; measurements: string[]; minFirmware?: Firmware | null; allowOutdated?: boolean; verifier?: (a: Attestation, p: ProviderAccount) => Promise<boolean> };

export class Registry {
  entries = new Map<string, ProviderEntry>();
  refreshedAt = 0;

  constructor(private conn: Connection, private tee: TeePolicy) {}

  async refresh(): Promise<void> {
    const accounts = await this.conn.getProgramAccounts(programId(), { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(ACCOUNT.Provider) } }] });
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
        const prev = this.entries.get(address);
        const same = prev && prev.account.manifestHash.equals(p.manifestHash) && prev.account.endpoint === p.endpoint && prev.manifest && Date.now() - prev.checkedAt < 10 * 60_000;
        const entry: ProviderEntry = same ? { ...prev!, account: p } : { address, account: p, manifest: null, problem: null, checkedAt: Date.now(), tee: null };
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
        entry.tee = await this.checkTee(entry);
        if (!same && p.active) entry.wire = await this.wireKey(p);
        this.entries.set(address, entry);
      }),
    );
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k);
    this.refreshedAt = Date.now();
  }

  /** The key a node wants requests encrypted to, accepted only with a signature from the node key on its listing. */
  /** Reads a node's wire key again, after the node said a request was encrypted to a key it no longer holds. */
  async refreshWire(address: string): Promise<void> {
    const e = this.entries.get(address);
    if (e) e.wire = await this.wireKey(e.account);
  }

  private async wireKey(p: ProviderAccount): Promise<Buffer | null> {
    try {
      const r = await fetchNode(`${p.endpoint.replace(/\/$/, '')}/v1/wire`, { timeoutMs: 4_000 });
      if (!r.ok) return null;
      const j = (await r.json()) as { key?: string; sig?: string };
      const key = Buffer.from(j.key ?? '', 'hex'), sig = Buffer.from(j.sig ?? '', 'hex');
      return key.length === 32 && ed25519Verify(p.nodeKey.toBytes(), wireMessage(key), sig) ? key : null;
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
  async checkHealth(): Promise<void> {
    await Promise.all(
      this.usable().map(async (e) => {
        const t0 = Date.now();
        const h = (await fetchNode(`${e.account.endpoint.replace(/\/$/, '')}/health`, { timeoutMs: 2_500 }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { upstream?: string } | null;
        if (!h) return;
        e.healthMs = Date.now() - t0;
        e.healthAt = Date.now();
        if (h.upstream === 'up' || h.upstream === 'down') e.upstream = h.upstream;
      }),
    );
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
        const j = (await fetchNode(`${e.account.endpoint.replace(/\/$/, '')}/orrery/burns`, { timeoutMs: 4_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { receipts?: BurnReceipt[] } | null;
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

  catalog(): { id: string; providers: number; cheapest: ModelOffer['price']; cachedFrom: number | null; context: number; private: number }[] {
    const by = new Map<string, { id: string; providers: number; cheapest: ModelOffer['price']; cachedFrom: number | null; context: number; private: number }>();
    for (const e of this.usable()) {
      for (const m of e.manifest!.models) {
        const c = by.get(m.id) ?? { id: m.id, providers: 0, cheapest: m.price, cachedFrom: null, context: m.context, private: 0 };
        c.providers += 1;
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
