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

import { reportDataFor, snpClaim } from '../src/tee/snp.ts';

describe('a node listing its SEV-SNP enclave', () => {
  it('takes the image from the report, and refuses a report made for another key with the data to ask for', () => {
    const key = Buffer.from(parsed.reportData.subarray(0, 32));
    assert.equal(snpClaim(report, key).measurement.toString('hex'), parsed.measurement.toString('hex'));
    assert.equal(snpClaim(report, key).debug, true);
    const other = Buffer.alloc(32, 9);
    assert.throws(() => snpClaim(report, other), new RegExp(reportDataFor(other).toString('hex')));
  });
});

describe('AMD firmware level', async () => {
  const { X509Certificate } = await import('node:crypto');
  const { chipFirmware, firmwareCheck, parseFirmware } = await import('../src/tee/snp.ts');
  const chip = chipFirmware(new X509Certificate(vcek))!;
  const at = { bootloader: 2, tee: 0, snp: 5, microcode: 68 };

  it('reads the same level from the report and from the chip certificate, and the same chip id', () => {
    assert.deepEqual(parsed.firmware, at);
    assert.deepEqual(chip.firmware, at);
    assert.ok(chip.chipId!.equals(parsed.chipId));
    const fw = verifySnp(base).checks!.find((c) => c.name === 'firmware')!;
    assert.deepEqual(fw, { name: 'firmware', ok: true, detail: 'boot loader 2 · tee 0 · snp 5 · microcode 68, the level this chip key was issued for' });
  });

  it('refuses a level the chip key was not issued for, and a certificate for another chip', () => {
    const newer = firmwareCheck({ reported: { ...at, snp: 9 }, reportChip: parsed.chipId, chip, family: 'Milan' });
    assert.equal(newer.ok, false);
    assert.match(newer.detail, /states boot loader 2 · tee 0 · snp 9 · microcode 68, but this chip key was issued for boot loader 2 · tee 0 · snp 5 · microcode 68/);
    const other = firmwareCheck({ reported: at, reportChip: Buffer.alloc(64, 7), chip, family: 'Milan' });
    assert.match(other.detail, /different chip/);
    // A VM launched with its chip id masked reports zeros: the level is still compared, the id is not.
    assert.equal(firmwareCheck({ reported: at, reportChip: Buffer.alloc(64), chip, family: 'Milan' }).ok, true);
  });

  it('holds the level to a minimum when the caller sets one', () => {
    assert.deepEqual(parseFirmware('3.0.8.115'), { bootloader: 3, tee: 0, snp: 8, microcode: 115 });
    for (const bad of ['', '3.0.8', '3.0.8.x', '3.0.8.999', '1.2.3.4.5']) assert.equal(parseFirmware(bad), null, bad);
    const low = verifySnp({ ...base, minFirmware: parseFirmware('3.0.8.115') });
    assert.equal(low.ok, false);
    assert.equal(low.reason, 'below your minimum: boot loader 2 < 3, snp 5 < 8, microcode 68 < 115');
    const met = verifySnp({ ...base, minFirmware: parseFirmware('2.0.5.68') });
    assert.equal(met.ok, true, met.reason);
    assert.match(met.checks!.find((c) => c.name === 'firmware')!.detail, /at or above your minimum/);
  });

  it('says so when it cannot compare: Turin’s other layout, or a certificate without the level', () => {
    assert.deepEqual(firmwareCheck({ reported: at, reportChip: parsed.chipId, chip, family: 'Turin' }), { name: 'firmware', ok: true, skipped: true, detail: 'firmware levels are laid out differently on Turin; not compared yet' });
    assert.equal(firmwareCheck({ reported: at, reportChip: parsed.chipId, chip: null, family: 'Milan' }).skipped, true);
  });
});
