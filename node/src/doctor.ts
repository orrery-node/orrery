// `orrery doctor`: reads everything a router needs and says what is ready. It only reads: the RPC, the program's config,
// every listing and the manifest it points to, your wallet's balances and the local router, if one is running.
import { rpcConnection } from './chain/connect.ts';
import { Connection, PublicKey } from '@solana/web3.js';
import { ACCOUNT, decodeChannel, decodeConfig, pda, programId, TEE_KINDS } from './chain/program.ts';
import { usd } from './pricing.ts';
import { readPins, Registry, type ProviderEntry } from './router/registry.ts';
import { fetchWithTimeout } from './sse.ts';
import { fetchNode, nodeProxy, type Proxy } from './proxy.ts';
import { askSeen, ownAddresses, seenSays, type Seen } from './seen.ts';

export type Check = { ok: boolean | null; what: string; detail: string };

/** How a request and its payment travel to a node, from what the node signed with its node key: sealed to the node's own
 * key with the payment inside, sealed with the payment in headers its host can read, or plain JSON inside TLS. */
export function sealCheck(e: ProviderEntry, pinned: boolean): Check {
  const what = '    sealing';
  if (!e.wire) return pinned
    ? { ok: false, what, detail: 'showed this router a signed wire key before and shows none now; nothing goes to it in the clear until it does' }
    : { ok: null, what, detail: 'no wire key: requests reach it as plain JSON inside TLS, which its host can read' };
  if (!e.wireInside) return { ok: null, what, detail: 'requests sealed to its own key; it does not sign that it reads payment inside, so which channel pays goes in headers its host can read' };
  const listed = e.manifest?.inside === true ? '; listed in its price list on chain, so kept to from a router’s first request' : '';
  return { ok: true, what, detail: `requests and payment sealed to its own key, both signed by its node key${listed}${pinned && !listed ? '; this router keeps to that if either goes missing' : ''}` };
}

const ms = (t0: number) => `${Date.now() - t0} ms`;
const n = (k: number | bigint, one: string, many = `${one}s`) => `${k} ${Number(k) === 1 ? one : many}`;

/** The lines to print. ok null means information only, nothing to fix. */
export async function doctor(o: { rpc: string; mint: PublicKey; wallet?: PublicKey; session?: PublicKey; router: string; deposit: bigint; allowDev?: boolean; version?: string; pins?: string }): Promise<Check[]> {
  const out: Check[] = [];
  if (o.version) {
    const latest = await fetchNode('https://registry.npmjs.org/orrery-node/latest', { timeoutMs: 3_000 }).then((r) => (r.ok ? r.json() : null)).then((j) => (j as { version?: string } | null)?.version ?? null).catch(() => null);
    out.push(versionCheck(o.version, latest));
  }
  const conn = rpcConnection(o.rpc);
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

  // The router's pins as it keeps them, read and not written: doctor's own reading of a node changes nothing there.
  const pins = readPins(o.pins);
  const registry = new Registry(conn, { allowDev: o.allowDev ?? false, measurements: [] });
  t0 = Date.now();
  await registry.refresh();
  const entries = [...registry.entries.values()];
  const up: { name: string; endpoint: string }[] = [];
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
    const h = await fetchNode(`${e.account.endpoint.replace(/\/$/, '')}/health`, { timeoutMs: 5_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { upstream?: 'up' | 'down' } | null;
    const took = ms(t0);
    if (h) up.push({ name, endpoint: e.account.endpoint.replace(/\/$/, '') });
    const detail = !h ? 'did not answer /health' : h.upstream === 'down' ? `answered /health in ${took}, but its model server is down` : `answered /health in ${took}${h.upstream === 'up' ? ', model server up' : ''}`;
    // Its track record, as its own listing counts it: every payout to its wallet is a transaction on chain.
    const payouts = Number(e.account.redeems);
    out.push({ ok: !!h && h.upstream !== 'down', what: `  ${name}`, detail: `${n(e.manifest.models.length, 'model')}, price list matches its hash on chain, paid out ${payouts} time${payouts === 1 ? '' : 's'} on chain, ${detail}` });
    // A node that claims an enclave: say whether this computer could verify it, and if not, which check stopped it.
    out.push(sealCheck(e, pins.has(e.account.nodeKey.toBase58())));
    if (e.tee) out.push({ ok: e.tee.verified ? true : e.tee.dev ? null : false, what: '    enclave', detail: `${TEE_KINDS[e.account.teeKind] ?? 'enclave'} · ${e.tee.verified ? `${e.tee.reason}; :private can use this node` : `not verified: ${e.tee.reason}`}` });
  }
  // What a node sees of this computer: the first node that says is asked, through the proxy when one is set.
  if (up.length) {
    const said = await askSeen(up);
    out.push(seenCheck(said?.name ?? null, said?.seen ?? null, nodeProxy(), ownAddresses()));
  }

  if (o.wallet) {
    const sol = await conn.getBalance(o.wallet);
    const usdc = await conn.getTokenAccountBalance(pda.ata(o.wallet, o.mint)).then((b) => BigInt(b.value.amount)).catch(() => 0n);
    out.push({ ok: sol >= 5_000_000, what: 'wallet SOL', detail: `${(sol / 1e9).toFixed(4)} SOL${sol >= 5_000_000 ? '' : ' · opening a channel needs about 0.005 for rent and fees'}` });
    out.push({ ok: usdc >= o.deposit, what: 'wallet USDC', detail: `$${usd(usdc, 2)}${usdc >= o.deposit ? '' : ` · one channel locks $${usd(o.deposit, 2)}`}` });
    // The wallet's channels on chain, and how many this computer's router can pick back up (same session key).
    const found = await conn
      .getProgramAccounts(programId(), {
        filters: [
          { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Channel).toString('base64'), encoding: 'base64' } },
          { memcmp: { offset: 8, bytes: o.wallet.toBase58() } },
        ],
      })
      .then((a) => a.map((x) => decodeChannel(x.account.data)))
      .catch(() => null);
    if (found === null) out.push({ ok: null, what: 'channels', detail: 'this RPC would not list program accounts; orrery channels --wallet tries again' });
    else if (!found.length) out.push({ ok: true, what: 'channels', detail: 'none on chain yet · the first request to a provider opens one' });
    else {
      const open = found.filter((c) => c.closingAt === 0n);
      const locked = open.reduce((s, c) => s + (c.deposit - c.redeemed), 0n);
      const mine = o.session ? open.filter((c) => c.sessionKey.equals(o.session!)).length : 0;
      const closing = found.length - open.length;
      out.push({ ok: true, what: 'channels', detail: `${n(open.length, 'open channel')}, $${usd(locked)} still on deposit${o.session ? ` · ${mine} under this computer's session key, picked back up on first use` : ''}${closing ? ` · ${closing} closing` : ''}` });
    }
  } else out.push({ ok: null, what: 'wallet', detail: 'pass --wallet <keypair.json> or --address <pubkey> to check its SOL and USDC' });

  t0 = Date.now();
  const status = await fetchWithTimeout(`${o.router.replace(/\/$/, '')}/orrery/status`, { timeoutMs: 2_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { route?: string; channels?: unknown[] } | null;
  out.push(status ? { ok: true, what: 'router', detail: `running at ${o.router}, route ${status.route}, ${n(status.channels?.length ?? 0, 'channel')}` } : { ok: null, what: 'router', detail: `not running at ${o.router}; start it with orrery router --wallet <keypair.json>` });
  return out;
}

/** Compares dotted versions: is b newer than a? */
/** One line on what a node sees of this computer. It fails only when a proxy is set and an address the node saw is
 * one of this computer's own; an address it cannot place is printed for the reader to compare. */
export function seenCheck(name: string | null, seen: Seen | null, proxy: Proxy | null, own: string[]): Check {
  return { what: 'seen as', ...seenSays(name, seen, proxy, own) };
}

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
