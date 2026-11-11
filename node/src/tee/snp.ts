// The built-in hardware verifier for AMD SEV-SNP. A provider that says it runs in an enclave serves the report its
// CPU signed; this checks that report the way AMD specifies, with nothing but Node's crypto and AMD's own roots:
// the chip's key (VCEK) chains to AMD's root for that processor family, the report carries the chip's signature,
// the VM was not launched in debug mode, it booted the image the provider claimed on chain, and the report names the
// encryption key the router is about to seal prompts to.
import { createHash, verify as verifySig, X509Certificate } from 'node:crypto';
import { AMD_CHAINS } from './amd-chains.ts';
import { revocation } from './crl.ts';
import { derInt, valueAfter } from './der.ts';

/** SHA-256 fingerprints of AMD's root keys (ARK), one per processor family. */
export const AMD_ROOTS: Record<string, string> = {
  Milan: '69d063b45344d26a2e94e1f4210de49ef555308287d4c174445c95639a540bcd',
  Genoa: '4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1',
  Turin: '1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a',
};

const SIGNED = 0x2a0;
const REPORT_LEN = 0x4a0;
const DEBUG_BIT = 1n << 19n;

/** A firmware level (AMD's TCB version): the patch levels of the chip's boot loader, trusted OS, SNP firmware and microcode. */
export type Firmware = { bootloader: number; tee: number; snp: number; microcode: number };
export type SnpReport = { version: number; policy: bigint; debug: boolean; reportData: Buffer; measurement: Buffer; chipId: Buffer; firmware: Firmware };
/** One step of a verification: what was looked at, whether it held, and what was found. */
export type Check = { name: string; ok: boolean; detail: string; skipped?: boolean };
export type SnpVerdict = { ok: boolean; reason: string; family?: string; report?: SnpReport; checks?: Check[] };

export function parseSnpReport(raw: Buffer): SnpReport {
  if (raw.length < REPORT_LEN) throw new Error(`a SEV-SNP report is ${REPORT_LEN} bytes, got ${raw.length}`);
  const policy = raw.readBigUInt64LE(0x08);
  return { version: raw.readUInt32LE(0), policy, debug: (policy & DEBUG_BIT) !== 0n, reportData: raw.subarray(0x50, 0x90), measurement: raw.subarray(0x90, 0xc0), chipId: raw.subarray(0x1a0, 0x1e0),
    // REPORTED_TCB at 0x180, in the Milan and Genoa layout: boot loader, trusted OS, four reserved bytes, SNP, microcode.
    firmware: { bootloader: raw[0x180], tee: raw[0x181], snp: raw[0x186], microcode: raw[0x187] } };
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

// AMD's extensions in a chip certificate (1.3.6.1.4.1.3704.1): the firmware level the key was issued for under .3, the chip's id under .4.
const AMD_EXT = '2b060104019c7801';
/** What the chip certificate says: the firmware level this key was derived for, and which chip it belongs to. */
export function chipFirmware(vcek: X509Certificate): { firmware: Firmware; chipId: Buffer | null } | null {
  const part = (n: string) => {
    const v = valueAfter(vcek.raw, `${AMD_EXT}03${n}`, 0x04);
    return v && v[0] === 0x02 ? derInt(v.subarray(2, 2 + v[1])) : null;
  };
  const [bootloader, tee, snp, microcode] = ['01', '02', '03', '08'].map(part);
  if (bootloader === null || tee === null || snp === null || microcode === null) return null;
  const id = valueAfter(vcek.raw, `${AMD_EXT}04`, 0x04);
  return { firmware: { bootloader, tee, snp, microcode }, chipId: id && id.length === 64 ? id : null };
}

const PARTS = ['bootloader', 'tee', 'snp', 'microcode'] as const;
const level = (f: Firmware) => PARTS.map((p) => `${p === 'bootloader' ? 'boot loader' : p} ${f[p]}`).join(' · ');
/** `2.0.5.68` → a firmware level; null when it is not four numbers. */
export function parseFirmware(s: string): Firmware | null {
  const n = s.split('.').map(Number);
  return n.length === 4 && n.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? { bootloader: n[0], tee: n[1], snp: n[2], microcode: n[3] } : null;
}

/** The firmware check: the level the report states is the one the chip key was issued for (AMD derives a different
 * key for every level, so a report cannot claim a newer one), the certificate is for this very chip, and the level is
 * not below a minimum the caller set. AMD publishes no signed list of current levels, so the minimum is the caller's. */
export function firmwareCheck(o: { reported: Firmware; reportChip: Buffer; chip: ReturnType<typeof chipFirmware>; family: string | null; min?: Firmware | null }): Check {
  if (o.family === 'Turin') return { name: 'firmware', ok: true, skipped: true, detail: 'firmware levels are laid out differently on Turin; not compared yet' };
  if (!o.chip) return { name: 'firmware', ok: true, skipped: true, detail: 'the chip certificate states no firmware level; not compared' };
  if (o.chip.chipId && o.reportChip.some((b) => b !== 0) && !o.chip.chipId.equals(o.reportChip)) return { name: 'firmware', ok: false, detail: 'the report comes from a different chip than this certificate' };
  if (PARTS.some((p) => o.reported[p] !== o.chip!.firmware[p])) return { name: 'firmware', ok: false, detail: `the report states ${level(o.reported)}, but this chip key was issued for ${level(o.chip.firmware)}` };
  const low = o.min ? PARTS.filter((p) => o.reported[p] < o.min![p]) : [];
  if (low.length) return { name: 'firmware', ok: false, detail: `below your minimum: ${low.map((p) => `${p === 'bootloader' ? 'boot loader' : p} ${o.reported[p]} < ${o.min![p]}`).join(', ')}` };
  return { name: 'firmware', ok: true, detail: `${level(o.reported)}, the level this chip key was issued for${o.min ? ', at or above your minimum' : ''}` };
}

/** The report stores r and s little-endian in 72 bytes each; P-384 verification wants them big-endian, 48 bytes each. */
function signatureOf(raw: Buffer): Buffer {
  const be = (o: number) => Buffer.from(raw.subarray(o, o + 48)).reverse();
  return Buffer.concat([be(SIGNED), be(SIGNED + 72)]);
}

export function verifySnp(o: { report: Buffer; vcek: Buffer; measurement: Buffer; enclaveKey: Buffer; now?: Date; allowDebug?: boolean; chains?: Record<string, string>; roots?: Record<string, string>; crls?: Buffer[]; minFirmware?: Firmware | null }): SnpVerdict {
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
  // Every check runs, so a caller can show them all; the verdict is the first one that failed.
  const family = chainOf(vcek, o.now ?? new Date(), o.chains ?? AMD_CHAINS, o.roots ?? AMD_ROOTS);
  const signed = verifySig('sha384', o.report.subarray(0, SIGNED), { key: vcek.publicKey, dsaEncoding: 'ieee-p1363' }, signatureOf(o.report));
  const checks: Check[] = [
    { name: 'chip certificate', ok: !!family, detail: family ? `chains to AMD's ${family} root (pinned)` : 'the chip certificate does not chain to an AMD root' },
    { name: 'signature', ok: signed, detail: signed ? 'the report carries that chip\'s signature' : 'the report is not signed by that chip' },
    firmwareCheck({ reported: report.firmware, reportChip: report.chipId, chip: chipFirmware(vcek), family, min: o.minFirmware }),
    { name: 'debugging', ok: !report.debug || !!o.allowDebug, detail: !report.debug ? 'off: the host cannot read this VM\'s memory' : o.allowDebug ? 'allowed by the launch policy (accepted because you said so)' : 'the VM was launched with debugging allowed, so its memory can be read by the host' },
    { name: 'image', ok: report.measurement.equals(o.measurement), detail: report.measurement.equals(o.measurement) ? `booted ${report.measurement.toString('hex').slice(0, 32)}…` : 'the VM booted a different image than the one claimed on chain' },
    { name: 'encryption key', ok: report.reportData.subarray(0, 32).equals(o.enclaveKey), detail: report.reportData.subarray(0, 32).equals(o.enclaveKey) ? `the report names ${o.enclaveKey.toString('hex').slice(0, 32)}…` : 'the report does not name this encryption key' },
  ];
  // AMD's revocation list for that processor family, when the caller has one: the signing key above the chip, and the chip's own certificate.
  if (o.crls && family) {
    const [askPem, arkPem] = pems((o.chains ?? AMD_CHAINS)[family]) as [string, string];
    const r = revocation([new X509Certificate(askPem), vcek], new X509Certificate(arkPem), o.crls, o.now ?? new Date());
    checks.splice(1, 0, !r.checked ? { name: 'revocation', ok: true, skipped: true, detail: "AMD's current revocation list could not be read; not checked" }
      : r.revoked ? { name: 'revocation', ok: false, detail: 'AMD has revoked a certificate in this chip\'s chain' }
      : { name: 'revocation', ok: true, detail: `not on AMD's revocation list for ${family} (${r.listed} revoked, list of ${r.asOf!.toISOString().slice(0, 10)})` });
  }
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
