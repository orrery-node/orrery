import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTEL_ROOT, parseTdxQuote, tdxFmspc, verifyTdx } from '../src/tee/tdx.ts';
import { acceptable, fetchTcbInfo, platformTcb, readTcbInfo, tcbStatus, type PlatformTcb, type TcbInfo, type TcbSource } from '../src/tee/tcb.ts';

// The same real Sapphire Rapids quote as tdx.test.ts, and Intel's signed TCB list for its platform family, fetched
// from api.trustedservices.intel.com on 2026-11-11 (the body and the TCB-Info-Issuer-Chain header, as served).
const quote = readFileSync(new URL('./fixtures/tdx-spr-quote.dat', import.meta.url));
const src = JSON.parse(readFileSync(new URL('./fixtures/intel-tdx-tcb.json', import.meta.url), 'utf8')) as TcbSource;
const parsed = parseTdxQuote(quote);
const now = new Date('2026-11-12T00:00:00Z');
const info = () => {
  const r = readTcbInfo(src.body, src.chain, { root: INTEL_ROOT, now });
  if ('problem' in r) throw new Error(r.problem);
  return r.info;
};
const zeros = (head: number[]) => [...head, ...Array(16 - head.length).fill(0)];
const plat = (cpu: number[], pce: number, tee: number[]): PlatformTcb => ({ fmspc: '50806f000000', pceSvn: pce, cpuSvn: zeros(cpu), teeTcbSvn: zeros(tee) });

describe('Intel TCB (patch level)', () => {
  it('reads what the platform runs from its certificate and the TD report', () => {
    assert.deepEqual(platformTcb(new X509Certificate(parsed.certs[0]), quote), plat([3, 3, 2, 2, 2, 1, 0, 2], 11, [3, 0, 4]));
    assert.equal(tdxFmspc(quote), '50806f000000');
    assert.equal(tdxFmspc(Buffer.alloc(40)), null);
  });

  it('accepts Intel’s list only when it is signed under the pinned root, for TDX, and not expired', () => {
    const i = info();
    assert.equal(i.id, 'TDX');
    assert.equal(i.fmspc.toLowerCase(), '50806f000000');
    assert.ok(i.tcbLevels.length >= 2);
    const bad = (r: ReturnType<typeof readTcbInfo>) => ('problem' in r ? r.problem : 'accepted');
    assert.match(bad(readTcbInfo(src.body.replace('OutOfDate', 'UpToDate '), src.chain, { root: INTEL_ROOT, now })), /signature .* does not verify/);
    assert.match(bad(readTcbInfo(src.body, src.chain, { root: '00', now })), /not signed under Intel/);
    assert.match(bad(readTcbInfo(src.body, '', { root: INTEL_ROOT, now })), /without its signing chain/);
    assert.match(bad(readTcbInfo(src.body, src.chain, { root: INTEL_ROOT, now: new Date(new Date(i.nextUpdate).getTime() + 86_400_000) })), /expired on/);
    assert.match(bad(readTcbInfo('{"nope":1}', src.chain, { root: INTEL_ROOT, now })), /not in the expected form/);
  });

  it('finds the level by Intel’s steps on Intel’s real list', () => {
    const i = info();
    const top = i.tcbLevels[0], next = i.tcbLevels[1];
    const of = (l: (typeof i.tcbLevels)[number]) => plat(l.tcb.sgxtcbcomponents.map((c) => c.svn), l.tcb.pcesvn, l.tcb.tdxtcbcomponents.map((c) => c.svn));
    assert.equal(top.tcbStatus, 'UpToDate');
    assert.equal(tcbStatus(of(top), i).status, 'UpToDate');
    assert.equal(tcbStatus(of(next), i).status, next.tcbStatus);
    assert.equal(tcbStatus(of(next), i).tcbDate, next.tcbDate);
    // One CPU component below the newest level drops the platform to an older one.
    const lower = of(top);
    lower.cpuSvn[0] -= 1;
    assert.notEqual(tcbStatus(lower, i).status, 'UpToDate');
    // The sample quote's platform is older than every level Intel lists.
    assert.equal(tcbStatus(platformTcb(new X509Certificate(parsed.certs[0]), quote), i).status, 'Unsupported');
    assert.equal(tcbStatus({ ...of(top), fmspc: '000000000000' }, i).status, 'Unsupported');
  });

  it('judges the TDX module too when the TD report names its version, and takes the worse of the two', () => {
    const made: TcbInfo = {
      id: 'TDX', version: 3, issueDate: '2026-11-11T00:00:00Z', nextUpdate: '2026-12-11T00:00:00Z', fmspc: '50806f000000',
      tcbLevels: [
        { tcb: { sgxtcbcomponents: zeros([9, 9]).map((svn) => ({ svn })), pcesvn: 11, tdxtcbcomponents: zeros([5, 0, 9]).map((svn) => ({ svn })) }, tcbDate: '2025-08-13T00:00:00Z', tcbStatus: 'UpToDate' },
        { tcb: { sgxtcbcomponents: zeros([5, 5]).map((svn) => ({ svn })), pcesvn: 5, tdxtcbcomponents: zeros([3, 0, 5]).map((svn) => ({ svn })) }, tcbDate: '2018-01-04T00:00:00Z', tcbStatus: 'OutOfDate', advisoryIDs: ['INTEL-SA-1'] },
      ],
      tdxModuleIdentities: [{ id: 'TDX_01', tcbLevels: [{ tcb: { isvsvn: 4 }, tcbDate: '2025-08-13T00:00:00Z', tcbStatus: 'UpToDate' }, { tcb: { isvsvn: 2 }, tcbDate: '2024-03-13T00:00:00Z', tcbStatus: 'OutOfDate', advisoryIDs: ['INTEL-SA-2'] }] }],
    };
    // No module version in the report: all sixteen TDX components are compared.
    assert.equal(tcbStatus(plat([9, 9], 11, [5, 0, 9]), made).status, 'UpToDate');
    assert.equal(tcbStatus(plat([9, 9], 11, [4, 0, 9]), made).status, 'OutOfDate');
    // Module version 1: components 0 and 1 are left to the module's own levels.
    assert.deepEqual(tcbStatus(plat([9, 9], 11, [4, 1, 9]), made), { status: 'UpToDate', platform: 'UpToDate', module: 'UpToDate', tcbDate: '2025-08-13T00:00:00Z', advisories: [] });
    assert.deepEqual(tcbStatus(plat([9, 9], 11, [3, 1, 9]), made), { status: 'OutOfDate', platform: 'UpToDate', module: 'OutOfDate', tcbDate: '2024-03-13T00:00:00Z', advisories: ['INTEL-SA-2'] });
    assert.equal(tcbStatus(plat([9, 9], 11, [1, 1, 9]), made).status, 'Unsupported');
    assert.equal(tcbStatus(plat([9, 9], 11, [4, 2, 9]), made).status, 'Unsupported');
    assert.equal(tcbStatus(plat([9, 9], 10, [5, 0, 9]), made).status, 'OutOfDate');
  });

  it('accepts current levels and refuses out-of-date, revoked and unknown ones', () => {
    for (const s of ['UpToDate', 'SWHardeningNeeded', 'ConfigurationNeeded', 'ConfigurationAndSWHardeningNeeded']) assert.equal(acceptable(s), true, s);
    for (const s of ['OutOfDate', 'OutOfDateConfigurationNeeded', 'Revoked', 'Unsupported', 'SomethingNew']) assert.equal(acceptable(s), false, s);
  });

  it('adds the patch level to a TDX verdict: refused when too old, said plainly when it could not be checked', () => {
    const base = { quote, measurement: Buffer.from(parsed.mrtd), enclaveKey: Buffer.from(parsed.reportData.subarray(0, 32)), now };
    const level = (o: Parameters<typeof verifyTdx>[0]) => verifyTdx(o).checks!.find((c) => c.name === 'patch level');
    assert.equal(level(base), undefined, 'not asked for, not reported');
    assert.deepEqual(level({ ...base, tcb: src }), { name: 'patch level', ok: false, detail: 'older than every level Intel supports (no TCB level matches this platform)' });
    assert.match(verifyTdx({ ...base, tcb: src }).reason, /older than every level Intel supports/);
    assert.equal(level({ ...base, tcb: src, allowOutdated: true })!.ok, true);
    assert.match(level({ ...base, tcb: src, allowOutdated: true })!.detail, /accepted because you said so/);
    assert.deepEqual(level({ ...base, tcb: null }), { name: 'patch level', ok: true, skipped: true, detail: "Intel's TCB list for this platform could not be read; not checked" });
    const tampered = level({ ...base, tcb: { body: src.body.replace('OutOfDate', 'UpToDate '), chain: src.chain } })!;
    assert.equal(tampered.skipped, true);
    assert.match(tampered.detail, /does not verify; not checked/);
  });

  it('fetches Intel’s list once, keeps it on disk, and serves the copy when Intel cannot be reached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-tcb-'));
    let calls = 0;
    const ok = async (url: string) => {
      calls += 1;
      assert.equal(url, 'https://api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=50806f000000');
      return { ok: true, text: async () => src.body, headers: { get: (n: string) => (n === 'TCB-Info-Issuer-Chain' ? encodeURIComponent(src.chain) : null) } };
    };
    const down = async () => { throw new Error('offline'); };
    const first = await fetchTcbInfo('50806f000000', dir, { fetchFn: ok, now: 1_000_000 });
    assert.deepEqual(first, src);
    await fetchTcbInfo('50806f000000', dir, { fetchFn: ok, now: 1_000_001 });
    assert.equal(calls, 1, 'fresh within twelve hours');
    const later = await fetchTcbInfo('50806f000000', dir, { fetchFn: down, now: Date.now() + 13 * 3_600_000 });
    assert.deepEqual(later, src, 'the disk copy when Intel is unreachable');
    assert.equal(await fetchTcbInfo('50806f000001', mkdtempSync(join(tmpdir(), 'orrery-tcb-')), { fetchFn: down }), null);
    assert.equal(await fetchTcbInfo('not-hex', dir, { fetchFn: ok }), null);
  });
});
