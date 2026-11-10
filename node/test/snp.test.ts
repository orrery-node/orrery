import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSnpReport, verifySnp } from '../src/tee/snp.ts';

// A real report from an AMD EPYC Milan machine and that chip's certificate, published as test data by
// github.com/google/go-sev-guest (verify/testdata). Its VM was launched with debugging allowed.
const report = readFileSync(new URL('./fixtures/snp-milan-report.bin', import.meta.url));
const vcek = readFileSync(new URL('./fixtures/snp-milan-vcek.der', import.meta.url));
const parsed = parseSnpReport(report);
const base = { report, vcek, measurement: Buffer.from(parsed.measurement), enclaveKey: Buffer.from(parsed.reportData.subarray(0, 32)), allowDebug: true };

describe('built-in AMD SEV-SNP verifier', () => {
  it('accepts a real report: chip key chains to AMD’s Milan root, signature, image and key all match', () => {
    const v = verifySnp(base);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.family, 'Milan');
  });
  it('refuses a VM launched with debugging allowed unless told to accept it', () => {
    assert.match(verifySnp({ ...base, allowDebug: false }).reason, /debugging allowed/);
  });
  it('refuses a report with one bit changed', () => {
    const forged = Buffer.from(report);
    forged[0x90] ^= 1;
    assert.match(verifySnp({ ...base, report: forged, measurement: Buffer.from(forged.subarray(0x90, 0xc0)) }).reason, /not signed by that chip/);
  });
  it('refuses another image, another key, and a certificate that is not AMD’s', () => {
    assert.match(verifySnp({ ...base, measurement: Buffer.alloc(48, 7) }).reason, /different image/);
    assert.match(verifySnp({ ...base, enclaveKey: Buffer.alloc(32, 7) }).reason, /does not name this encryption key/);
    assert.match(verifySnp({ ...base, roots: { Milan: '00', Genoa: '00', Turin: '00' } }).reason, /does not chain to an AMD root/);
    assert.match(verifySnp({ ...base, now: new Date('2031-01-01') }).reason, /does not chain/);
  });
});
