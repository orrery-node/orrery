// The built-in hardware verifier for AMD SEV-SNP. A provider that says it runs in an enclave serves the report its
// CPU signed; this checks that report the way AMD specifies, with nothing but Node's crypto and AMD's own roots:
// the chip's key (VCEK) chains to AMD's root for that processor family, the report carries the chip's signature,
// the VM was not launched in debug mode, it booted the image the provider claimed on chain, and the report names the
// encryption key the router is about to seal prompts to.
import { createHash, verify as verifySig, X509Certificate } from 'node:crypto';
import { AMD_CHAINS } from './amd-chains.ts';

/** SHA-256 fingerprints of AMD's root keys (ARK), one per processor family. */
export const AMD_ROOTS: Record<string, string> = {
  Milan: '69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd',
  Genoa: '4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1',
  Turin: '1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a',
};

const SIGNED = 0x2a0;
const REPORT_LEN = 0x4a0;
const DEBUG_BIT = 1n << 19n;

export type SnpReport = { version: number; policy: bigint; debug: boolean; reportData: Buffer; measurement: Buffer; chipId: Buffer };
/** One step of a verification: what was looked at, whether it held, and what was found. */
export type Check = { name: string; ok: boolean; detail: string };
export type SnpVerdict = { ok: boolean; reason: string; family?: string; report?: SnpReport; checks?: Check[] };

export function parseSnpReport(raw: Buffer): SnpReport {
  if (raw.length < REPORT_LEN) throw new Error(`a SEV-SNP report is ${REPORT_LEN} bytes, got ${raw.length}`);
  const policy = raw.readBigUInt64LE(0x08);
  return { version: raw.readUInt32LE(0), policy, debug: (policy & DEBUG_BIT) !== 0n, reportData: raw.subarray(0x50, 0x90), measurement: raw.subarray(0x90, 0xc0), chipId: raw.subarray(0x1a0, 0x1e0) };
}

const pems = (bundle: string) => bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
const fingerprint = (c: X509Certificate) => createHash('sha256').update(c.raw).digest('hex');
const current = (c: X509Certificate, now: Date) => new Date(c.validFrom) <= now && now <= new Date(c.validTo);

/** Which AMD family signed this chip key, by walking VCEK → ASK → ARK and matching the ARK to a pinned root. */
function chainOf(vcek: X509Certificate, now: Date, chains: Record<string, string>, roots: Record<string, string>): string | null {
  for (const [family, bundle] of Object.entries(chains)) {
    const [askPem, arkPem] = pems(bundle);
    if (!askPem || !arkPem) continue;
    const ask = new X509Certificate(askPem), ark = new X509Certificate(arkPem);
    if (fingerprint(ark) !== roots[family]) continue;
    if (!ark.verify(ark.publicKey) || !ask.verify(ark.publicKey) || !vcek.verify(ask.publicKey)) continue;
    if (![ark, ask, vcek].every((c) => current(c, now))) continue;
    return family;
  }
  return null;
}

/** The report stores r and s little-endian in 72 bytes each; P-384 verification wants them big-endian, 48 bytes each. */
function signatureOf(raw: Buffer): Buffer {
  const be = (o: number) => Buffer.from(raw.subarray(o, o + 48)).reverse();
  return Buffer.concat([be(SIGNED), be(SIGNED + 72)]);
}

export function verifySnp(o: { report: Buffer; vcek: Buffer; measurement: Buffer; enclaveKey: Buffer; now?: Date; allowDebug?: boolean; chains?: Record<string, string>; roots?: Record<string, string> }): SnpVerdict {
  let report: SnpReport;
  try {
    report = parseSnpReport(o.report);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (report.version < 2) return { ok: false, reason: `report version ${report.version} is too old` };
  if (o.report.readUInt32LE(0x34) !== 1) return { ok: false, reason: 'the report is not signed with ECDSA P-384' };
  let vcek: X509Certificate;
  try {
    vcek = new X509Certificate(o.vcek);
  } catch {
    return { ok: false, reason: 'the chip certificate (VCEK) could not be read' };
  }
  // Every check runs, so a caller can show all five; the verdict is the first one that failed.
  const family = chainOf(vcek, o.now ?? new Date(), o.chains ?? AMD_CHAINS, o.roots ?? AMD_ROOTS);
  const signed = verifySig('sha384', o.report.subarray(0, SIGNED), { key: vcek.publicKey, dsaEncoding: 'ieee-p1363' }, signatureOf(o.report));
  const checks: Check[] = [
    { name: 'chip certificate', ok: !!family, detail: family ? `chains to AMD's ${family} root (pinned)` : 'the chip certificate does not chain to an AMD root' },
    { name: 'signature', ok: signed, detail: signed ? 'the report carries that chip\'s signature' : 'the report is not signed by that chip' },
    { name: 'debugging', ok: !report.debug || !!o.allowDebug, detail: !report.debug ? 'off: the host cannot read this VM\'s memory' : o.allowDebug ? 'allowed by the launch policy (accepted because you said so)' : 'the VM was launched with debugging allowed, so its memory can be read by the host' },
    { name: 'image', ok: report.measurement.equals(o.measurement), detail: report.measurement.equals(o.measurement) ? `booted ${report.measurement.toString('hex').slice(0, 32)}…` : 'the VM booted a different image than the one claimed on chain' },
    { name: 'encryption key', ok: report.reportData.subarray(0, 32).equals(o.enclaveKey), detail: report.reportData.subarray(0, 32).equals(o.enclaveKey) ? `the report names ${o.enclaveKey.toString('hex').slice(0, 32)}…` : 'the report does not name this encryption key' },
  ];
  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, reason: failed ? failed.detail : `AMD SEV-SNP report verified (${family})`, family: family ?? undefined, report, checks };
}

/** The 64 bytes a node asks its CPU to put in the report (`snpguest report --request-data`): its encryption key, then zeros. */
export const reportDataFor = (enclaveKey: Buffer) => Buffer.concat([enclaveKey, Buffer.alloc(32)]);

/** What a node lists on chain from the report its CPU signed: the image it booted. Refuses a report made for another key. */
export function snpClaim(report: Buffer, enclaveKey: Buffer): { measurement: Buffer; debug: boolean } {
  const r = parseSnpReport(report);
  if (!r.reportData.subarray(0, 32).equals(enclaveKey)) throw new Error(`this report was not made for this node's encryption key; ask the CPU for one with report data ${reportDataFor(enclaveKey).toString('hex')}`);
  return { measurement: Buffer.from(r.measurement), debug: r.debug };
}
