// What the router knows about the network: every Provider account on chain, plus the price manifest each node
// serves, kept only if its sha256 matches the hash the provider's wallet put on chain.
import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ACCOUNT, decodeProvider, programId, type ProviderAccount } from '../chain/program.ts';
import { checkManifest, manifestHash, type Manifest, type ModelOffer } from '../manifest.ts';
import { fetchWithTimeout } from '../sse.ts';

export type Attestation = { kind: number; measurement: string; enclaveKey: string; report: string; reportHash: string };

export type ProviderEntry = {
  address: string;
  account: ProviderAccount;
  manifest: Manifest | null;
  problem: string | null;
  checkedAt: number;
  tee: { verified: boolean; dev: boolean; reason: string; enclaveKey: Buffer } | null;
};

export type TeePolicy = { allowDev: boolean; measurements: string[]; verifier?: (a: Attestation, p: ProviderAccount) => Promise<boolean> };

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
            const r = await fetchWithTimeout(`${p.endpoint.replace(/\/$/, '')}/v1/manifest`, { timeoutMs: 4_000 });
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
        this.entries.set(address, entry);
      }),
    );
    for (const k of [...this.entries.keys()]) if (!seen.has(k)) this.entries.delete(k);
    this.refreshedAt = Date.now();
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
      const r = await fetchWithTimeout(`${p.endpoint.replace(/\/$/, '')}/v1/attestation`, { timeoutMs: 4_000 });
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
      if (!this.tee.verifier) return { verified: false, dev: false, reason: 'no hardware verifier configured', enclaveKey };
      const ok = await this.tee.verifier(a, p);
      return { verified: ok, dev: false, reason: ok ? 'hardware report verified' : 'hardware verifier rejected the report', enclaveKey };
    } catch (err) {
      return { verified: false, dev: false, reason: `attestation fetch failed: ${(err as Error).message}`, enclaveKey };
    }
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

  catalog(): { id: string; providers: number; cheapest: ModelOffer['price']; context: number; private: number }[] {
    const by = new Map<string, { id: string; providers: number; cheapest: ModelOffer['price']; context: number; private: number }>();
    for (const e of this.usable()) {
      for (const m of e.manifest!.models) {
        const c = by.get(m.id) ?? { id: m.id, providers: 0, cheapest: m.price, context: m.context, private: 0 };
        c.providers += 1;
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
