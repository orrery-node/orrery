// `orrery enclave verify --node <listing>`: audit a private node yourself. Reads the node's enclave claim from its
// account on Solana, asks the node for the report its CPU signed, and runs every check a router runs before it
// seals a prompt, one line per check.
import { createHash } from 'node:crypto';
import { TEE_KINDS, type ProviderAccount } from '../chain/program.ts';
import { verifySnp, type Check } from './snp.ts';
import { verifyTdx } from './tdx.ts';

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type Audit = { ok: boolean; kind: string; reason: string; checks: Check[] };

export async function auditEnclave(p: ProviderAccount, o: { fetchFn?: Fetch; now?: Date; allowDebug?: boolean } = {}): Promise<Audit> {
  const kind = TEE_KINDS[p.teeKind] ?? 'enclave';
  if (p.teeKind === 0) return { ok: false, kind: 'none', reason: 'this node does not claim an enclave', checks: [] };
  const now = o.now ?? new Date();
  const checks: Check[] = [];
  const live = BigInt(Math.floor(now.getTime() / 1000)) < p.teeExpiresAt;
  checks.push({ name: 'claim on chain', ok: live, detail: live ? `${kind}, valid until ${new Date(Number(p.teeExpiresAt) * 1000).toISOString().slice(0, 10)}` : 'the claim on chain has expired' });
  const f = o.fetchFn ?? (fetch as unknown as Fetch);
  const a = (await f(`${p.endpoint.replace(/\/$/, '')}/v1/attestation`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { report?: string; enclaveKey?: string; vcek?: string } | null;
  if (!a?.report) {
    checks.push({ name: 'report', ok: false, detail: 'the node did not serve a report at /v1/attestation' });
    return { ok: false, kind, reason: checks[checks.length - 1].detail, checks };
  }
  const report = Buffer.from(a.report, 'base64');
  const same = createHash('sha256').update(report).digest().equals(p.teeReportHash);
  checks.push({ name: 'report', ok: same, detail: same ? 'the report the node serves is the one it claimed on chain' : 'the report the node serves is not the one it claimed on chain' });
  let dev = false;
  try {
    dev = JSON.parse(report.toString('utf8')).dev === true;
  } catch {
    dev = false;
  }
  if (dev) checks.push({ name: 'hardware', ok: false, detail: 'a software stand-in for local testing, not a hardware report' });
  else if (p.teeKind === 2) checks.push(...(a.vcek ? verifySnp({ report, vcek: Buffer.from(a.vcek, 'base64'), measurement: Buffer.from(p.teeMeasurement), enclaveKey: Buffer.from(p.teeKey), now, allowDebug: o.allowDebug }).checks ?? [{ name: 'hardware', ok: false, detail: 'the report could not be read' }] : [{ name: 'chip certificate', ok: false, detail: 'the node did not serve its chip certificate' }]));
  else if (p.teeKind === 1) checks.push(...(verifyTdx({ quote: report, measurement: Buffer.from(p.teeMeasurement), enclaveKey: Buffer.from(p.teeKey), now, allowDebug: o.allowDebug }).checks ?? [{ name: 'hardware', ok: false, detail: 'the quote could not be read' }]));
  else checks.push({ name: 'hardware', ok: false, detail: `no built-in verifier for ${kind} yet` });
  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, kind, reason: failed ? failed.detail : `${kind} verified: a router would seal prompts to this node`, checks };
}

export const renderChecks = (checks: Check[]) => checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name.padEnd(21)}${c.detail}`).join('\n');
