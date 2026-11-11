// Revocation. AMD and Intel each publish signed lists of certificates they have withdrawn: a chip or platform whose
// key leaked, or an intermediate that should no longer be trusted. A report can pass every other check and still come
// from hardware its maker has revoked, so the verifiers read these lists too. The lists come straight from the chip
// maker, are checked against the same pinned roots, and are cached on disk; no attestation service is involved.
import { constants, verify as verifySig, type X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Crl = { thisUpdate: Date; nextUpdate: Date | null; revoked: Set<string>; tbs: Buffer; alg: string; signature: Buffer };

type Tlv = { tag: number; start: number; body: number; end: number };

function tlv(buf: Buffer, at: number): Tlv {
  if (at + 2 > buf.length) throw new Error('truncated');
  const tag = buf[at];
  let len = buf[at + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
    hdr = 2 + n;
  }
  const end = at + hdr + len;
  if (end > buf.length) throw new Error('truncated');
  return { tag, start: at, body: at + hdr, end };
}

function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = parent.body; p < parent.end; ) {
    const c = tlv(buf, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function time(buf: Buffer, t: Tlv): Date {
  const s = buf.subarray(t.body, t.end).toString('latin1');
  const full = t.tag === 0x17 ? `${Number(s.slice(0, 2)) >= 50 ? '19' : '20'}${s}` : s;
  return new Date(`${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}Z`);
}

/** A serial number as the chip makers' lists and Node's certificates both spell it: lowercase hex, no leading zeros. */
export const serialOf = (hex: string) => BigInt(`0x${hex || '0'}`).toString(16);

const ALGS: Record<string, string> = { '2a8648ce3d040302': 'ecdsa-sha256', '2a8648ce3d040303': 'ecdsa-sha384', '2a864886f70d01010a': 'rsa-pss' };

/** Reads an X.509 certificate revocation list (DER): its dates, the serial numbers it revokes, and what was signed. */
export function parseCrl(der: Buffer): Crl {
  const [tbs, alg, sig] = children(der, tlv(der, 0));
  if (!tbs || !alg || !sig || sig.tag !== 0x03) throw new Error('not a revocation list');
  const t = children(der, tbs);
  let i = 0;
  if (t[i]?.tag === 0x02) i++;
  i += 2;
  const thisUpdate = time(der, t[i++]);
  const nextUpdate = t[i] && (t[i].tag === 0x17 || t[i].tag === 0x18) ? time(der, t[i++]) : null;
  const revoked = new Set<string>();
  if (t[i]?.tag === 0x30) for (const entry of children(der, t[i])) {
    const [serial] = children(der, entry);
    revoked.add(serialOf(der.subarray(serial.body, serial.end).toString('hex')));
  }
  const oid = children(der, alg)[0];
  return { thisUpdate, nextUpdate, revoked, tbs: der.subarray(tbs.start, tbs.end), alg: ALGS[der.subarray(oid.body, oid.end).toString('hex')] ?? 'unknown', signature: der.subarray(sig.body + 1, sig.end) };
}

/** Whether this list carries the issuer's signature. Intel signs with ECDSA, AMD with RSA-PSS over SHA-384. */
export function crlSignedBy(crl: Crl, issuer: X509Certificate): boolean {
  try {
    if (crl.alg === 'ecdsa-sha256') return verifySig('sha256', crl.tbs, issuer.publicKey, crl.signature);
    if (crl.alg === 'ecdsa-sha384') return verifySig('sha384', crl.tbs, issuer.publicKey, crl.signature);
    if (crl.alg === 'rsa-pss') return verifySig('sha384', crl.tbs, { key: issuer.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, crl.signature);
  } catch {
    return false;
  }
  return false;
}

export type Revocation = { checked: boolean; revoked: boolean; listed: number; asOf: Date | null };

/** Looks `certs` up on whichever of `lists` their issuer signed and that is current. A list that is not the issuer's,
 * is malformed or has run past its next update is not used. */
export function revocation(certs: X509Certificate[], issuer: X509Certificate, lists: Buffer[], now: Date): Revocation {
  for (const der of lists) {
    let crl: Crl;
    try {
      crl = parseCrl(der);
    } catch {
      continue;
    }
    if (!crlSignedBy(crl, issuer)) continue;
    if (crl.thisUpdate > now || (crl.nextUpdate && crl.nextUpdate < now)) continue;
    return { checked: true, revoked: certs.some((c) => crl.revoked.has(serialOf(c.serialNumber))), listed: crl.revoked.size, asOf: crl.thisUpdate };
  }
  return { checked: false, revoked: false, listed: 0, asOf: null };
}

/** Where each chip maker publishes its lists. */
export const CRL_URLS: Record<'amd' | 'intel', string[]> = {
  amd: ['Milan', 'Genoa', 'Turin'].map((p) => `https://kdsintf.amd.com/vcek/v1/${p}/crl`),
  intel: [
    'https://api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=platform&encoding=der',
    'https://api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=processor&encoding=der',
    'https://certificates.trustedservices.intel.com/IntelSGXRootCA.der',
  ],
};

type Fetch = (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
const fresh = new Map<string, { at: number; lists: Buffer[] }>();

/** The chip maker's current lists, fetched at most every twelve hours and kept in `dir` so a restart or a moment
 * offline still has the last ones. A list that cannot be fetched is served from disk; with neither, it is left out
 * and the verifier says revocation was not checked. */
export async function fetchCrls(maker: 'amd' | 'intel', dir: string | null, o: { fetchFn?: Fetch; now?: number; maxAgeMs?: number } = {}): Promise<Buffer[]> {
  const now = o.now ?? Date.now(), maxAge = o.maxAgeMs ?? 12 * 3_600_000;
  const hit = fresh.get(`${maker}:${dir}`);
  if (hit && now - hit.at < maxAge) return hit.lists;
  const f = o.fetchFn ?? (fetch as unknown as Fetch);
  const lists: Buffer[] = [];
  await Promise.all(CRL_URLS[maker].map(async (url, i) => {
    const path = dir ? join(dir, `${maker}-${i}.crl`) : null;
    if (path && existsSync(path) && now - statSync(path).mtimeMs < maxAge) return void lists.push(readFileSync(path));
    try {
      const r = await f(url);
      if (!r.ok) throw new Error('not ok');
      const der = Buffer.from(await r.arrayBuffer());
      parseCrl(der);
      if (path) {
        mkdirSync(dir!, { recursive: true });
        writeFileSync(path, der);
      }
      lists.push(der);
    } catch {
      if (path && existsSync(path)) lists.push(readFileSync(path));
    }
  }));
  fresh.set(`${maker}:${dir}`, { at: now, lists });
  return lists;
}
