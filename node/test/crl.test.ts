import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crlSignedBy, fetchCrls, parseCrl, revocation, serialOf } from '../src/tee/crl.ts';
import { parseSnpReport, verifySnp } from '../src/tee/snp.ts';
import { parseTdxQuote, verifyTdx } from '../src/tee/tdx.ts';

// Real lists, fetched from Intel and AMD on 11 Nov 2026: Intel's list of revoked platform certificates and its root
// list, and AMD's list for the Milan family.
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const intelPlatform = fx('intel-pck-platform.crl'), intelRoot = fx('intel-root.crl'), amdMilan = fx('amd-milan.crl');
const now = new Date('2026-11-11T12:00:00Z');
const quote = fx('tdx-spr-quote.dat');
const q = parseTdxQuote(quote);
const [pck, mid, root] = q.certs.slice(0, 3).map((c) => new X509Certificate(c));

describe('revocation lists', () => {
  it('reads Intel’s real list: 57 platforms revoked, signed by the CA in the quote’s own chain', () => {
    const crl = parseCrl(intelPlatform);
    assert.equal(crl.revoked.size, 57);
    assert.equal(crl.alg, 'ecdsa-sha256');
    assert.equal(crlSignedBy(crl, mid), true);
    assert.equal(crlSignedBy(crl, root), false);
    assert.equal(crlSignedBy(parseCrl(intelRoot), root), true);
  });
  it('rejects a list with one byte changed, and one that is not a list at all', () => {
    const tampered = Buffer.from(intelPlatform);
    tampered[200] ^= 1;
    assert.equal(crlSignedBy(parseCrl(tampered), mid), false);
    assert.deepEqual(revocation([pck], mid, [Buffer.from('not a list'), tampered], now), { checked: false, revoked: false, listed: 0, asOf: null });
  });
  it('finds a certificate that is on the list, clears one that is not, and does not use a list past its next update', () => {
    const revokedSerial = [...parseCrl(intelPlatform).revoked][0];
    const onList = { serialNumber: revokedSerial.toUpperCase() } as unknown as X509Certificate;
    assert.equal(revocation([onList], mid, [intelRoot, intelPlatform], now).revoked, true);
    const clear = revocation([pck], mid, [intelRoot, intelPlatform], now);
    assert.deepEqual([clear.checked, clear.revoked, clear.listed], [true, false, 57]);
    assert.equal(revocation([pck], mid, [intelPlatform], new Date('2027-06-01T00:00:00Z')).checked, false);
    assert.equal(serialOf('00AB'), 'ab');
  });
  it('AMD’s list is signed by the family root with RSA-PSS and checked the same way', () => {
    const report = fx('snp-milan-report.bin'), r = parseSnpReport(report);
    const v = verifySnp({ report, vcek: fx('snp-milan-vcek.der'), measurement: Buffer.from(r.measurement), enclaveKey: Buffer.from(r.reportData.subarray(0, 32)), allowDebug: true, now, crls: [amdMilan] });
    assert.equal(v.ok, true, v.reason);
    assert.match(v.checks!.find((c) => c.name === 'revocation')!.detail, /not on AMD's revocation list for Milan \(0 revoked, list of 2026-10-27\)/);
  });
  it('the TDX verifier adds a revocation line when it has lists, says so when it has none that apply, and stays silent offline', () => {
    const base = { quote, measurement: Buffer.from(q.mrtd), enclaveKey: Buffer.from(q.reportData.subarray(0, 32)), now };
    const withLists = verifyTdx({ ...base, crls: [intelPlatform, intelRoot] });
    assert.equal(withLists.ok, true, withLists.reason);
    assert.match(withLists.checks!.find((c) => c.name === 'revocation')!.detail, /57 platforms revoked/);
    const none = verifyTdx({ ...base, crls: [] }).checks!.find((c) => c.name === 'revocation')!;
    assert.deepEqual([none.ok, none.skipped], [true, true]);
    assert.equal(verifyTdx(base).checks!.some((c) => c.name === 'revocation'), false);
  });
  it('fetches the lists once, keeps them on disk, and falls back to the disk copy when the chip maker cannot be reached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-crl-'));
    let calls = 0;
    const ok = async () => { calls++; return { ok: true, arrayBuffer: async () => intelPlatform.buffer.slice(intelPlatform.byteOffset, intelPlatform.byteOffset + intelPlatform.byteLength) as ArrayBuffer }; };
    assert.equal((await fetchCrls('intel', dir, { fetchFn: ok, now: 1_000 })).length, 3);
    assert.equal(calls, 3);
    assert.equal((await fetchCrls('intel', dir, { fetchFn: ok, now: 2_000 })).length, 3);
    assert.equal(calls, 3);
    const down = async () => { throw new Error('unreachable'); };
    assert.equal((await fetchCrls('intel', dir, { fetchFn: down, now: Date.now() + 86_400_000 * 2, maxAgeMs: 1 })).length, 3);
  });
});
