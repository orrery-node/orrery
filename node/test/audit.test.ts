import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditEnclave } from '../src/tee/audit.ts';
import { parseSnpReport } from '../src/tee/snp.ts';
import { parseTdxQuote } from '../src/tee/tdx.ts';
import type { ProviderAccount } from '../src/chain/program.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const snp = fx('snp-milan-report.bin'), vcek = fx('snp-milan-vcek.der'), tdx = fx('tdx-spr-quote.dat');
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const listing = (kind: number, measurement: Buffer, key: Buffer, report: Buffer, expires = 4_000_000_000n) => ({ endpoint: 'https://node.example', teeKind: kind, teeMeasurement: Buffer.from(measurement), teeKey: Buffer.from(key), teeReportHash: sha(report), teeExpiresAt: expires }) as unknown as ProviderAccount;
const serve = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

describe('auditing a private node', () => {
  const r = parseSnpReport(snp), q = parseTdxQuote(tdx);
  const tdxNow = new Date(new Date(new X509Certificate(q.certs[0]).validFrom).getTime() + 86_400_000);

  it('walks an AMD SEV-SNP node check by check, and stops it for a VM that allows debugging', async () => {
    const p = listing(2, r.measurement, r.reportData.subarray(0, 32), snp);
    const a = await auditEnclave(p, { fetchFn: serve({ report: snp.toString('base64'), vcek: vcek.toString('base64') }) });
    assert.equal(a.ok, false);
    assert.deepEqual(a.checks.map((c) => [c.name, c.ok]), [['claim on chain', true], ['report', true], ['chip certificate', true], ['signature', true], ['debugging', false], ['image', true], ['encryption key', true]]);
    assert.equal((await auditEnclave(p, { allowDebug: true, fetchFn: serve({ report: snp.toString('base64'), vcek: vcek.toString('base64') }) })).ok, true);
  });
  it('verifies an Intel TDX node end to end', async () => {
    const a = await auditEnclave(listing(1, q.mrtd, q.reportData.subarray(0, 32), tdx), { now: tdxNow, fetchFn: serve({ report: tdx.toString('base64') }) });
    assert.equal(a.ok, true, a.reason);
    assert.equal(a.checks.length, 8);
  });
  it('catches a node serving another report than it claimed, an expired claim, and a software stand-in', async () => {
    const other = Buffer.from(tdx); other[100] ^= 1;
    const swapped = await auditEnclave(listing(1, q.mrtd, q.reportData.subarray(0, 32), tdx), { now: tdxNow, fetchFn: serve({ report: other.toString('base64') }) });
    assert.equal(swapped.checks.find((c) => c.name === 'report')?.ok, false);
    const expired = await auditEnclave(listing(1, q.mrtd, q.reportData.subarray(0, 32), tdx, 1n), { now: tdxNow, fetchFn: serve({ report: tdx.toString('base64') }) });
    assert.match(expired.reason, /expired/);
    const dev = Buffer.from(JSON.stringify({ dev: true }));
    const standIn = await auditEnclave(listing(3, Buffer.alloc(48), Buffer.alloc(32), dev), { fetchFn: serve({ report: dev.toString('base64') }) });
    assert.match(standIn.reason, /software stand-in/);
  });
});
