// `orrery provider check`: everything a node needs to earn, looked at from the operator's side before (or after) it
// lists: the model server, the address routers will call, the listing on chain, the fee money, the enclave, the pledge.
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { decodeProvider } from '../chain/program.ts';
import { usd } from '../pricing.ts';
import { readWire } from '../router/registry.ts';
import { fetchWithTimeout } from '../sse.ts';
import { verifySnp } from '../tee/snp.ts';
import { verifyTdx } from '../tee/tdx.ts';
import { folderRisk, folderWarning } from './folder.ts';
import { FEE_FLOOR_LAMPORTS, type ProviderNode } from './node.ts';

export type CheckLine = { ok: boolean | null; what: string; detail: string };

export async function providerCheck(node: ProviderNode): Promise<CheckLine[]> {
  const cfg = node.cfg, out: CheckLine[] = [];
  const base = cfg.upstream.baseUrl.replace(/\/$/, '');
  const key = cfg.upstream.apiKey ?? (cfg.upstream.apiKeyEnv ? process.env[cfg.upstream.apiKeyEnv] : undefined);
  const models = (await fetchWithTimeout(`${base}/models`, { timeoutMs: 5_000, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(cfg.upstream.headers ?? {}) } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { data?: { id: string }[] } | null;
  if (!models) out.push({ ok: false, what: 'model server', detail: `${base} did not answer /models` });
  else {
    const have = new Set((models.data ?? []).map((m) => m.id));
    const missing = cfg.models.filter((m) => have.size && !have.has(m.upstreamModel ?? m.id)).map((m) => m.upstreamModel ?? m.id);
    out.push({ ok: missing.length ? null : true, what: 'model server', detail: missing.length ? `answers at ${base}; its /models list does not name ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} (fine if it accepts those names anyway)` : `answers at ${base}, serves all ${cfg.models.length} listed model${cfg.models.length === 1 ? '' : 's'}` });
  }

  const t0 = Date.now();
  const health = (await fetchWithTimeout(`${cfg.publicUrl.replace(/\/$/, '')}/health`, { timeoutMs: 5_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { provider?: string } | null;
  const local = /^https?:\/\/(127\.|localhost|0\.0\.0\.0|10\.|192\.168\.)/.test(cfg.publicUrl);
  out.push(!health ? { ok: false, what: 'public address', detail: `${cfg.publicUrl} did not answer /health (is the node running, and reachable from outside?)` }
    : health.provider !== node.pda.toBase58() ? { ok: false, what: 'public address', detail: `${cfg.publicUrl} answers as another listing` }
    : { ok: local ? null : true, what: 'public address', detail: `${cfg.publicUrl} answered in ${Date.now() - t0} ms${local ? ', but only machines on your network can reach that address' : ''}` });

  // What routers read of this node's wire key, fetched from the public address as they fetch it. A hosting platform in
  // front of the node can change that answer, and routers then send less sealed than the node offers.
  const wire = (await fetchWithTimeout(`${cfg.publicUrl.replace(/\/$/, '')}/v1/wire`, { timeoutMs: 5_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as Parameters<typeof readWire>[0] | null;
  const read = wire ? readWire(wire, node.node.publicKey) : null;
  out.push(!health ? { ok: null, what: 'wire key', detail: 'not read: the public address did not answer' }
    : !wire ? { ok: false, what: 'wire key', detail: `${cfg.publicUrl} did not answer /v1/wire, so routers send this node plain requests that whatever is in front of it can read` }
    : !read ? { ok: false, what: 'wire key', detail: 'what arrives at /v1/wire is not signed by this node key, so routers do not seal requests to this node' }
    : !read.key.equals(node.wire.publicKey) ? { ok: false, what: 'wire key', detail: 'routers read a wire key at your address that is not the one this node holds (another node answering there?)' }
    : !read.inside ? { ok: false, what: 'wire key', detail: 'routers read the key, but not the signed flag that payment goes inside: something in front of this node drops it, so routers new to this node send the channel in headers' }
    : { ok: true, what: 'wire key', detail: `routers read it signed, payment inside: what sits in front of this node sees neither prompts nor which channel pays${node.manifest.inside ? '; listed in your price list on chain, so routers keep to it from their first request' : '. Set "paymentInside": true and register again to list it on chain, so routers keep to it from their first request'}` });

  const info = await node.conn.getAccountInfo(node.pda);
  const acct = info ? decodeProvider(info.data) : null;
  if (!acct) out.push({ ok: false, what: 'listing', detail: 'not on chain yet: orrery provider register --config … --wallet …' });
  else {
    const same = acct.manifestHash.equals(node.manifestHash), url = acct.endpoint === cfg.publicUrl;
    out.push({ ok: same && url && acct.active, what: 'listing', detail: !acct.active ? 'on chain but closed' : !same ? 'your price list changed since you listed; run provider register again so routers accept it' : !url ? `on chain with another address (${acct.endpoint}); run provider register again` : `on chain, price list matches, $${usd(acct.settled)} settled in ${acct.redeems} redeems` });
  }

  const sol = (await node.conn.getBalance(node.node.publicKey)) / LAMPORTS_PER_SOL;
  const enough = sol >= FEE_FLOOR_LAMPORTS / LAMPORTS_PER_SOL;
  out.push({ ok: enough, what: 'node key', detail: `${sol.toFixed(4)} SOL for redeem fees${enough ? '' : `; send a little to ${node.node.publicKey.toBase58()}`}` });

  // A redemption costs its transaction fee whatever it moves; a minimum under a cent means paying more than is collected.
  const min = cfg.redeem?.minUnits;
  if (min !== undefined && min < 10_000) out.push({ ok: null, what: 'redeem', detail: `redeem.minUnits is ${min} ($${(min / 1e6).toFixed(6)}): each redemption costs a transaction fee, usually more than that. 50000 (five cents) is the default` });

  const earned = node.status();
  out.push({ ok: null, what: 'earnings', detail: `$${earned.signed} signed to this node, $${earned.redeemed} redeemed, $${earned.waiting} waiting` });
  // What is waiting exists only in the ledger file in the data folder, so the folder has to outlive a restart.
  const risk = folderRisk(node.dir);
  out.push(risk ? { ok: risk === 'temporary' ? false : null, what: 'data folder', detail: folderWarning(node.dir, earned.waiting)! }
    : { ok: true, what: 'data folder', detail: `${node.dir} keeps what routers signed to you; $${earned.waiting} waiting there to be redeemed` });

  if (node.attestation && node.enclave && cfg.tee && cfg.tee.mode !== 'dev') {
    const v = cfg.tee.mode === 'snp'
      ? verifySnp({ report: node.attestation.report, vcek: node.vcekDer()!, measurement: node.attestation.measurement, enclaveKey: node.enclave.publicKey })
      : verifyTdx({ quote: node.attestation.report, measurement: node.attestation.measurement, enclaveKey: node.enclave.publicKey });
    const claimed = !!acct && acct.teeKind === node.attestation.kind && acct.teeReportHash.equals(node.attestation.reportHash);
    out.push({ ok: v.ok && claimed, what: 'enclave', detail: !v.ok ? `a router would refuse it: ${v.reason}` : !claimed ? `${v.reason}, but the claim is not on chain: orrery provider attest --config …` : `${v.reason}; routers can send you :private requests` });
  } else if (cfg.tee?.mode === 'dev') out.push({ ok: null, what: 'enclave', detail: 'a software stand-in for local testing; routers do not treat it as hardware' });

  if (cfg.burn) out.push({ ok: null, what: 'burn pledge', detail: `${cfg.burn.share / 100}% of what you redeem; orrery provider burn --config … shows what is due` });
  return out;
}

export const renderCheck = (name: string, lines: CheckLine[]) => [`"${name}"`, ...lines.map((l) => `${l.ok === null ? '·' : l.ok ? '✓' : '✗'} ${l.what.padEnd(15)}${l.detail}`)].join('\n');
