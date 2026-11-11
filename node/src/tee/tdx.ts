// The built-in hardware verifier for Intel TDX. A TDX quote is checked the way Intel specifies, with Node's crypto
// and Intel's own root: the platform's certificate (PCK) chains to Intel's SGX root, Intel's quoting enclave signed
// for the key that signed this quote, that key signed the quote, the VM was not launched in debug mode, it booted
// the image the provider claimed on chain, and the quote names the key the router is about to seal prompts to.
import { createHash, createPublicKey, verify as verifySig, X509Certificate, type KeyObject } from 'node:crypto';
import type { Check } from './snp.ts';
import { revocation } from './crl.ts';
import { acceptable, platformTcb, readTcbInfo, tcbStatus, type TcbSource } from './tcb.ts';

/** SHA-256 fingerprint of Intel's SGX Root CA, which TDX platform certificates chain to. */
export const INTEL_ROOT = '44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3';

const BODY = 48, BODY_LEN = 584, SIGNED = BODY + BODY_LEN;

export type TdxQuote = { version: number; debug: boolean; mrtd: Buffer; reportData: Buffer; signature: Buffer; attestKey: Buffer; qeReport: Buffer; qeSignature: Buffer; qeAuth: Buffer; certs: string[] };
export type TdxVerdict = { ok: boolean; reason: string; quote?: TdxQuote; checks?: Check[] };

export function parseTdxQuote(raw: Buffer): TdxQuote {
  if (raw.length < SIGNED + 4 + 128) throw new Error('too short to be a TDX quote');
  const version = raw.readUInt16LE(0);
  if (version !== 4) throw new Error(`quote version ${version} is not supported (version 4 is)`);
  if (raw.readUInt16LE(2) !== 2) throw new Error('the quote is not signed with ECDSA P-256');
  if (raw.readUInt32LE(4) !== 0x81) throw new Error('this is not a TDX quote');
  const attrs = raw.readBigUInt64LE(BODY + 120);
  let o = SIGNED + 4;
  const signature = raw.subarray(o, o + 64); o += 64;
  const attestKey = raw.subarray(o, o + 64); o += 64;
  if (raw.readUInt16LE(o) !== 6) throw new Error('the quote carries no quoting-enclave report');
  o += 6;
  const qeReport = raw.subarray(o, o + 384); o += 384;
  const qeSignature = raw.subarray(o, o + 64); o += 64;
  const authLen = raw.readUInt16LE(o); o += 2;
  const qeAuth = raw.subarray(o, o + authLen); o += authLen;
  if (raw.readUInt16LE(o) !== 5) throw new Error('the quote carries no certificate chain');
  const certLen = raw.readUInt32LE(o + 2); o += 6;
  const certs = raw.subarray(o, o + certLen).toString('latin1').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return { version, debug: (attrs & 1n) !== 0n, mrtd: raw.subarray(BODY + 136, BODY + 184), reportData: raw.subarray(BODY + 520, BODY + 584), signature, attestKey, qeReport, qeSignature, qeAuth, certs };
}

/** A raw P-256 public key (x then y, 32 bytes each) as a key object. */
function p256(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32, 64).toString('base64url') }, format: 'jwk' });
}

const current = (c: X509Certificate, now: Date) => new Date(c.validFrom) <= now && now <= new Date(c.validTo);

/** The platform family (FMSPC) in a quote's certificate: what Intel's TCB list is asked for. Null if it cannot be read. */
export function tdxFmspc(quote: Buffer): string | null {
  try {
    return platformTcb(new X509Certificate(parseTdxQuote(quote).certs[0]), quote).fmspc;
  } catch {
    return null;
  }
}

export function verifyTdx(o: { quote: Buffer; measurement: Buffer; enclaveKey: Buffer; now?: Date; allowDebug?: boolean; root?: string; crls?: Buffer[]; tcb?: TcbSource | null; allowOutdated?: boolean }): TdxVerdict {
  let q: TdxQuote;
  try {
    q = parseTdxQuote(o.quote);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (q.certs.length < 3) return { ok: false, reason: 'the quote does not carry the platform’s full certificate chain', quote: q };
  let pck: X509Certificate, mid: X509Certificate, root: X509Certificate;
  try {
    [pck, mid, root] = q.certs.slice(0, 3).map((c) => new X509Certificate(c));
  } catch {
    return { ok: false, reason: 'the platform certificate could not be read', quote: q };
  }
  // Every check runs, so a caller can show all of them; the verdict is the first one that failed.
  const now = o.now ?? new Date();
  const chained = createHash('sha256').update(root.raw).digest('hex') === (o.root ?? INTEL_ROOT) && root.verify(root.publicKey) && mid.verify(root.publicKey) && pck.verify(mid.publicKey) && [root, mid, pck].every((c) => current(c, now));
  const qeSigned = verifySig('sha256', q.qeReport, { key: pck.publicKey, dsaEncoding: 'ieee-p1363' }, q.qeSignature);
  const vouched = q.qeReport.subarray(320, 352).equals(createHash('sha256').update(q.attestKey).update(q.qeAuth).digest());
  const signed = verifySig('sha256', o.quote.subarray(0, SIGNED), { key: p256(q.attestKey), dsaEncoding: 'ieee-p1363' }, q.signature);
  const checks: Check[] = [
    { name: 'platform certificate', ok: chained, detail: chained ? "chains to Intel's root (pinned)" : 'the platform certificate does not chain to Intel’s root' },
    { name: 'quoting enclave', ok: qeSigned && vouched, detail: !qeSigned ? 'Intel’s quoting enclave report is not signed by that platform' : !vouched ? 'the quoting enclave did not vouch for the key that signed this quote' : "Intel's quoting enclave vouches for the signing key" },
    { name: 'signature', ok: signed, detail: signed ? 'that key signed this exact quote' : 'the quote is not signed by the attested key' },
    { name: 'debugging', ok: !q.debug || !!o.allowDebug, detail: !q.debug ? "off: the host cannot read this VM's memory" : o.allowDebug ? 'allowed (accepted because you said so)' : 'the VM was launched with debugging allowed, so its memory can be read by the host' },
    { name: 'image', ok: q.mrtd.equals(o.measurement), detail: q.mrtd.equals(o.measurement) ? `booted ${q.mrtd.toString('hex').slice(0, 32)}…` : 'the VM booted a different image than the one claimed on chain' },
    { name: 'encryption key', ok: q.reportData.subarray(0, 32).equals(o.enclaveKey), detail: q.reportData.subarray(0, 32).equals(o.enclaveKey) ? `the quote names ${o.enclaveKey.toString('hex').slice(0, 32)}…` : 'the quote does not name this encryption key' },
  ];
  // Intel's revocation lists, when the caller has them: the platform's certificate, and the CA that issued it.
  if (o.crls) {
    const leaf = revocation([pck], mid, o.crls, now), ca = revocation([mid], root, o.crls, now);
    checks.splice(1, 0, leaf.revoked || ca.revoked ? { name: 'revocation', ok: false, detail: leaf.revoked ? 'Intel has revoked this platform’s certificate' : 'Intel has revoked the CA that issued this platform’s certificate' }
      : !leaf.checked ? { name: 'revocation', ok: true, skipped: true, detail: "Intel's current revocation list could not be read; not checked" }
      : { name: 'revocation', ok: true, detail: `not on Intel's revocation list (${leaf.listed} platforms revoked, list of ${leaf.asOf!.toISOString().slice(0, 10)})` });
  }
  // Intel's TCB list for this platform family, when the caller has it: is the microcode and TDX module it runs current?
  if (o.tcb !== undefined) {
    const skip = (why: string): Check => ({ name: 'patch level', ok: true, skipped: true, detail: `${why}; not checked` });
    let level: Check;
    const read = o.tcb ? readTcbInfo(o.tcb.body, o.tcb.chain, { root: o.root ?? INTEL_ROOT, now }) : null;
    if (!read) level = skip("Intel's TCB list for this platform could not be read");
    else if ('problem' in read) level = skip(read.problem);
    else {
      try {
        const v = tcbStatus(platformTcb(pck, o.quote), read.info);
        const said = `Intel lists this platform as ${v.status}${v.tcbDate ? ` (level of ${v.tcbDate.slice(0, 10)})` : ''}`;
        const anyway = o.allowOutdated ? ', accepted because you said so' : '';
        level = v.status === 'Unsupported' ? { name: 'patch level', ok: !!o.allowOutdated, detail: `older than every level Intel supports (${v.module ?? v.platform})${anyway}` }
          : acceptable(v.status) ? { name: 'patch level', ok: true, detail: `${said}${v.advisories.length ? `, with ${v.advisories.length} ${v.advisories.length === 1 ? 'advisory' : 'advisories'} to read` : ''}` }
          : { name: 'patch level', ok: !!o.allowOutdated, detail: `${said}: fixes Intel has published are missing${anyway}` };
      } catch (e) {
        level = skip((e as Error).message);
      }
    }
    const at = checks.findIndex((c) => c.name === 'revocation');
    checks.splice(at >= 0 ? at + 1 : 1, 0, level);
  }
  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, reason: failed ? failed.detail : 'Intel TDX quote verified', quote: q, checks };
}

/** What a node lists on chain from its TDX quote: the image it booted. Refuses a quote made for another key. */
export function tdxClaim(quote: Buffer, enclaveKey: Buffer): { measurement: Buffer; debug: boolean } {
  const q = parseTdxQuote(quote);
  if (!q.reportData.subarray(0, 32).equals(enclaveKey)) throw new Error(`this quote was not made for this node's encryption key; ask for one with report data ${Buffer.concat([enclaveKey, Buffer.alloc(32)]).toString('hex')}`);
  return { measurement: Buffer.from(q.mrtd), debug: q.debug };
}
