// `orrery doctor`: reads everything a router needs and says what is ready. It only reads: the RPC, the program's config,
// every listing and the manifest it points to, your wallet's balances and the local router, if one is running.
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeConfig, pda } from './chain/program.ts';
import { usd } from './pricing.ts';
import { Registry } from './router/registry.ts';
import { fetchWithTimeout } from './sse.ts';

export type Check = { ok: boolean | null; what: string; detail: string };

const ms = (t0: number) => `${Date.now() - t0} ms`;
const n = (k: number | bigint, one: string, many = `${one}s`) => `${k} ${Number(k) === 1 ? one : many}`;

/** The lines to print. ok null means information only, nothing to fix. */
export async function doctor(o: { rpc: string; mint: PublicKey; wallet?: PublicKey; router: string; deposit: bigint; allowDev?: boolean; version?: string }): Promise<Check[]> {
  const out: Check[] = [];
  if (o.version) {
    const latest = await fetchWithTimeout('https://registry.npmjs.org/orrery-node/latest', { timeoutMs: 3_000 }).then((r) => (r.ok ? r.json() : null)).then((j) => (j as { version?: string } | null)?.version ?? null).catch(() => null);
    out.push(versionCheck(o.version, latest));
  }
  const conn = new Connection(o.rpc, 'confirmed');
  let t0 = Date.now();
  try {
    const slot = await conn.getSlot();
    out.push({ ok: true, what: 'rpc', detail: `${new URL(o.rpc).host} answered in ${ms(t0)} at slot ${slot.toLocaleString('en-US')}` });
  } catch (e) {
    out.push({ ok: false, what: 'rpc', detail: `${new URL(o.rpc).host} did not answer: ${(e as Error).message}` });
    return out;
  }

  const cfgInfo = await conn.getAccountInfo(pda.config());
  if (!cfgInfo) out.push({ ok: false, what: 'program', detail: 'no config account at this program id on this cluster' });
  else {
    const c = decodeConfig(cfgInfo.data);
    out.push({ ok: c.settleMint.equals(o.mint), what: 'program', detail: `${n(c.providers, 'provider')}, ${n(c.channels, 'channel')}, $${usd(c.settled)} settled · close grace ${Number(c.closeGraceSecs) / 60} min · settles in ${c.settleMint.equals(o.mint) ? 'USDC' : c.settleMint.toBase58()}` });
  }

  const registry = new Registry(conn, { allowDev: o.allowDev ?? false, measurements: [] });
  t0 = Date.now();
  await registry.refresh();
  const entries = [...registry.entries.values()];
  out.push({ ok: entries.some((e) => e.account.active && e.manifest && !e.problem), what: 'listings', detail: `${entries.length} on chain, read in ${ms(t0)}` });
  for (const e of entries) {
    const name = e.manifest?.name ?? e.address.slice(0, 8);
    if (!e.account.active) {
      out.push({ ok: null, what: `  ${name}`, detail: 'listing closed' });
      continue;
    }
    if (e.problem || !e.manifest) {
      out.push({ ok: false, what: `  ${name}`, detail: e.problem ?? 'no manifest' });
      continue;
    }
    t0 = Date.now();
    const health = await fetchWithTimeout(`${e.account.endpoint.replace(/\/$/, '')}/health`, { timeoutMs: 5_000 }).then((r) => r.ok).catch(() => false);
    out.push({ ok: health, what: `  ${name}`, detail: `${n(e.manifest.models.length, 'model')}, price list matches its hash on chain, ${health ? `answered /health in ${ms(t0)}` : 'did not answer /health'}` });
  }

  if (o.wallet) {
    const sol = await conn.getBalance(o.wallet);
    const usdc = await conn.getTokenAccountBalance(pda.ata(o.wallet, o.mint)).then((b) => BigInt(b.value.amount)).catch(() => 0n);
    out.push({ ok: sol >= 5_000_000, what: 'wallet SOL', detail: `${(sol / 1e9).toFixed(4)} SOL${sol >= 5_000_000 ? '' : ' · opening a channel needs about 0.005 for rent and fees'}` });
    out.push({ ok: usdc >= o.deposit, what: 'wallet USDC', detail: `$${usd(usdc, 2)}${usdc >= o.deposit ? '' : ` · one channel locks $${usd(o.deposit, 2)}`}` });
  } else out.push({ ok: null, what: 'wallet', detail: 'pass --wallet <keypair.json> or --address <pubkey> to check its SOL and USDC' });

  t0 = Date.now();
  const status = await fetchWithTimeout(`${o.router.replace(/\/$/, '')}/orrery/status`, { timeoutMs: 2_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { route?: string; channels?: unknown[] } | null;
  out.push(status ? { ok: true, what: 'router', detail: `running at ${o.router}, route ${status.route}, ${n(status.channels?.length ?? 0, 'channel')}` } : { ok: null, what: 'router', detail: `not running at ${o.router}; start it with orrery router --wallet <keypair.json>` });
  return out;
}

/** Compares dotted versions: is b newer than a? */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) > (pa[i] ?? 0);
  }
  return false;
}

export function versionCheck(current: string, latest: string | null): Check {
  if (!latest) return { ok: null, what: 'version', detail: `${current}; npm did not answer` };
  if (newer(current, latest)) return { ok: null, what: 'version', detail: `${current}; ${latest} is on npm: npx -y orrery-node@latest` };
  if (newer(latest, current)) return { ok: true, what: 'version', detail: `${current}, ahead of npm (${latest})` };
  return { ok: true, what: 'version', detail: `${current}, the latest on npm` };
}

export function render(lines: Check[]): string {
  return lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '·'} ${l.what.padEnd(14)} ${l.detail}`).join('\n');
}
