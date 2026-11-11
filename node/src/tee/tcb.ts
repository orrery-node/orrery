// Is the chip behind a TDX quote patched? Intel publishes, per platform family (FMSPC), a signed list of TCB levels:
// which microcode and TDX module versions are current, which are out of date, which are revoked. A quote says what
// the platform runs (in its certificate and in the TD report); this file reads both and finds the level, following
// the steps in Intel's PCS documentation ("Get TDX TCB Info", API v4). The list is checked against the same pinned
// Intel root as the platform certificate, so nobody in between can hand the router a kinder one.
import { outFetch } from '../proxy.ts';
import { createHash, verify as verifySig, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { derInt, valueAfter } from './der.ts';

/** What a platform runs, as its PCK certificate and TD report state it. */
export type PlatformTcb = { fmspc: string; pceSvn: number; cpuSvn: number[]; teeTcbSvn: number[] };

// Intel's SGX extension in a PCK certificate: 1.2.840.113741.1.13.1, with the TCB under .2 and the FMSPC under .4.
const SGX = '2a864886f84d010d01';
/** A field of that extension. The certificate is Intel-signed and already verified by the caller. */
function after(raw: Buffer, tail: string, tag: number): Buffer {
  const v = valueAfter(raw, SGX + tail, tag);
  if (!v) throw new Error('the platform certificate carries no SGX TCB extension in the expected form');
  return v;
}
const int = derInt;

export function platformTcb(pck: X509Certificate, quote: Buffer): PlatformTcb {
  const raw = pck.raw;
  return {
    fmspc: after(raw, '04', 0x04).toString('hex'),
    pceSvn: int(after(raw, '0211', 0x02)),
    cpuSvn: Array.from({ length: 16 }, (_, i) => int(after(raw, `02${(i + 1).toString(16).padStart(2, '0')}`, 0x02))),
    // TEE_TCB_SVN: the first 16 bytes of the TD report body, which starts 48 bytes into a version 4 quote.
    teeTcbSvn: [...quote.subarray(48, 64)],
  };
}

type Level = { tcbDate: string; tcbStatus: string; advisoryIDs?: string[] };
export type TcbInfo = {
  id: string; version: number; issueDate: string; nextUpdate: string; fmspc: string;
  tcbLevels: (Level & { tcb: { sgxtcbcomponents: { svn: number }[]; pcesvn: number; tdxtcbcomponents: { svn: number }[] } })[];
  tdxModuleIdentities?: { id: string; tcbLevels: (Level & { tcb: { isvsvn: number } })[] }[];
};

/** Reads Intel's answer: the body exactly as served and the issuer chain from its `TCB-Info-Issuer-Chain` header.
 * Refuses a list not signed under the pinned root, one that is not for TDX, and one past its `nextUpdate`. */
export function readTcbInfo(body: string, chainPem: string, o: { root: string; now: Date }): { info: TcbInfo } | { problem: string } {
  const pems = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (pems.length < 2) return { problem: 'Intel’s TCB list came without its signing chain' };
  let signer: X509Certificate, root: X509Certificate;
  try {
    [signer, root] = pems.slice(0, 2).map((p) => new X509Certificate(p));
  } catch {
    return { problem: 'the signing chain of Intel’s TCB list could not be read' };
  }
  const live = (c: X509Certificate) => new Date(c.validFrom) <= o.now && o.now <= new Date(c.validTo);
  if (createHash('sha256').update(root.raw).digest('hex') !== o.root || !root.verify(root.publicKey) || !signer.verify(root.publicKey) || !live(signer) || !live(root)) return { problem: 'Intel’s TCB list is not signed under Intel’s root' };
  // The signature covers the tcbInfo object byte for byte as served, so it is cut out of the body, not re-serialised.
  const m = /^\s*\{"tcbInfo":(\{[\s\S]*\}),"signature":"([0-9a-fA-F]{128})"\}\s*$/.exec(body);
  if (!m) return { problem: 'Intel’s TCB list is not in the expected form' };
  if (!verifySig('sha256', Buffer.from(m[1]), { key: signer.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[2], 'hex'))) return { problem: 'the signature on Intel’s TCB list does not verify' };
  let info: TcbInfo;
  try {
    info = JSON.parse(m[1]) as TcbInfo;
  } catch {
    return { problem: 'Intel’s TCB list is not valid JSON' };
  }
  if (info.id !== 'TDX' || !Array.isArray(info.tcbLevels)) return { problem: 'the list is not a TDX TCB list' };
  if (!(new Date(info.nextUpdate) > o.now)) return { problem: `Intel’s TCB list expired on ${String(info.nextUpdate).slice(0, 10)}` };
  return { info };
}

// From best to worst. A status this file does not know counts as the worst.
const RANK = ['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded', 'OutOfDate', 'OutOfDateConfigurationNeeded', 'Revoked'];
const rank = (s: string) => (RANK.includes(s) ? RANK.indexOf(s) : RANK.length);
/** Statuses a router accepts: current, or current with advice that concerns software or configuration. */
export const acceptable = (status: string) => rank(status) <= RANK.indexOf('ConfigurationAndSWHardeningNeeded');

export type TcbVerdict = { status: string; platform: string; module: string | null; tcbDate: string | null; advisories: string[] };

/** The platform's TCB level by Intel's steps: the first level whose CPU, PCE and TDX component versions the platform
 * meets; then, when the TD report names a TDX module version, that module's own level. The verdict is the worse. */
export function tcbStatus(p: PlatformTcb, info: TcbInfo): TcbVerdict {
  if (info.fmspc.toLowerCase() !== p.fmspc.toLowerCase()) return { status: 'Unsupported', platform: 'the list is for another platform family', module: null, tcbDate: null, advisories: [] };
  const from = p.teeTcbSvn[1] === 0 ? 0 : 2;
  const level = info.tcbLevels.find((l) =>
    l.tcb.sgxtcbcomponents.every((c, i) => p.cpuSvn[i] >= c.svn)
    && p.pceSvn >= l.tcb.pcesvn
    && l.tcb.tdxtcbcomponents.every((c, i) => i < from || p.teeTcbSvn[i] >= c.svn));
  if (!level) return { status: 'Unsupported', platform: 'no TCB level matches this platform', module: null, tcbDate: null, advisories: [] };
  let module: Level | null = null;
  if (p.teeTcbSvn[1] >= 1) {
    const idOf = `TDX_${p.teeTcbSvn[1].toString(16).padStart(2, '0').toUpperCase()}`;
    const ident = (info.tdxModuleIdentities ?? []).find((m) => m.id.toUpperCase() === idOf);
    module = ident?.tcbLevels.find((l) => p.teeTcbSvn[0] >= l.tcb.isvsvn) ?? null;
    if (!module) return { status: 'Unsupported', platform: level.tcbStatus, module: `no TCB level matches TDX module ${idOf}`, tcbDate: level.tcbDate, advisories: level.advisoryIDs ?? [] };
  }
  const worse = module && rank(module.tcbStatus) > rank(level.tcbStatus) ? module : level;
  return { status: worse.tcbStatus, platform: level.tcbStatus, module: module?.tcbStatus ?? null, tcbDate: worse.tcbDate, advisories: [...new Set([...(level.advisoryIDs ?? []), ...(module?.advisoryIDs ?? [])])] };
}

export type TcbSource = { body: string; chain: string };
type Fetch = (url: string) => Promise<{ ok: boolean; text(): Promise<string>; headers: { get(name: string): string | null } }>;
const fresh = new Map<string, { at: number; got: TcbSource | null }>();
export const TCB_URL = (fmspc: string) => `https://api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=${fmspc}`;

/** Intel's current TCB list for a platform family, fetched at most every twelve hours and kept in `dir`, so a restart
 * or a moment offline still has the last one. Null when it can be had from neither; the verifier then says the patch
 * level was not checked. */
export async function fetchTcbInfo(fmspc: string, dir: string | null, o: { fetchFn?: Fetch; now?: number; maxAgeMs?: number } = {}): Promise<TcbSource | null> {
  if (!/^[0-9a-f]{12}$/i.test(fmspc)) return null;
  const now = o.now ?? Date.now(), maxAge = o.maxAgeMs ?? 12 * 3_600_000, key = `${fmspc}:${dir}`;
  const hit = fresh.get(key);
  if (hit && now - hit.at < maxAge) return hit.got;
  const path = dir ? join(dir, `tdx-${fmspc.toLowerCase()}.json`) : null;
  const disk = (): TcbSource | null => {
    try {
      return path && existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as TcbSource) : null;
    } catch {
      return null;
    }
  };
  let got: TcbSource | null = path && existsSync(path) && now - statSync(path).mtimeMs < maxAge ? disk() : null;
  if (!got) {
    try {
      const r = await (o.fetchFn ?? (outFetch as unknown as Fetch))(TCB_URL(fmspc));
      if (!r.ok) throw new Error('not ok');
      got = { body: await r.text(), chain: decodeURIComponent(r.headers.get('TCB-Info-Issuer-Chain') ?? '') };
      if (path) {
        mkdirSync(dir!, { recursive: true });
        writeFileSync(path, JSON.stringify(got));
      }
    } catch {
      got = disk();
    }
  }
  fresh.set(key, { at: now, got });
  return got;
}
