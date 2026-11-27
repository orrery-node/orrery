// `orrery doctor`: reads everything a router needs and says what is ready. It only reads: the RPC, the program's config,
// every listing and the manifest it points to, your wallet's balances and the local router, if one is running.
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { rpcConnection } from './chain/connect.ts';
import { Connection, PublicKey } from '@solana/web3.js';
import { ACCOUNT, decodeChannel, decodeConfig, pda, programId, TEE_KINDS } from './chain/program.ts';
import { usd } from './pricing.ts';
import { readPins, Registry, rpcLeftOutLine, type ProviderEntry } from './router/registry.ts';
import { fetchWithTimeout } from './sse.ts';
import { PACKAGE_VERSION } from './version.ts';
import { type PeerSum, relayOrder, readIntroductions, readPeerNotes, readRelayFull, readRelayHolders, readRelayHoldersOnly, readRelayOpen, readRelayPort, peerText } from './router/notes.ts';
import { answeredText, watchedText, type Watched } from './router/watched.ts';
import { billsText, speedText, skipNote, unansweredNote, readTrips, readUnanswered } from './spend.ts';
import { startRouter } from './connect.ts';
import { fetchNode, nodeProxy, type Proxy } from './proxy.ts';
import { askSeen, ownAddresses, seenSays, type Seen } from './seen.ts';
import { privacySentence, type Pace, type NodePrivacy } from './privacy.ts';
import { bytesText } from './router/relay.ts';

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

/** One line on how private this router's requests are right now, from what the lines above found: how many nodes take
 * the request and the payment sealed, how many run in an enclave this computer verified (where :private can go), whether
 * a proxy keeps this computer's address from the nodes and the RPC, and that client IDs never leave. */
export function privacyLine(nodes: NodePrivacy[], proxied: boolean, pace?: Pace): Check {
  return { ok: null, what: 'privacy', detail: privacySentence(nodes, proxied, pace) };
}

const ms = (t0: number) => `${Date.now() - t0} ms`;
const n = (k: number | bigint, one: string, many = `${one}s`) => `${k} ${Number(k) === 1 ? one : many}`;

/** The lines to print. ok null means information only, nothing to fix. */
type Spent = { total?: { answers: number; usd: string }; afterANodeDidNotAnswer?: { answers: number; nodes: number }; finishedByAnotherNode?: number; unanswered?: { requests: number; nodes: number }; speed?: { provider: string; name: string; answers: number; medianTtftMs: number }[]; bills?: { provider: string; name: string; checked: number; over: number }[] };

/** The router line when none answers: how to start one the way it starts now. A wallet this command could read (from
 * --wallet, ORRERY_WALLET or the home folder) is the one the router uses without --wallet. */
export const routerMissing = (router: string, hasWallet: boolean) => `not running at ${router}; start it with ${startRouter(hasWallet, 'orrery')}`;

/** How fast each node started answering this router in the last 24 hours, by the router's own log: one line a node. */
export function speedLines(sp: Spent | null): string[] {
  return (sp?.speed ?? []).map((s) => `${s.name} ${speedText(s)}`);
}

/** What this router found when it checked each node's bills against the prices the node listed on chain, last 24 hours. */
export function billsLines(sp: Spent | null): string[] {
  return (sp?.bills ?? []).filter((b) => b.checked > 0).map((b) => `${b.name} ${billsText(b)}`);
}

/** What a running router's /orrery/spend says about its last 24 hours, as one line: what it paid, and the answers
 * where a node did not answer or did not finish (signed nothing). Null when the router did not say. */
export function paidLine(sp: Spent | null): string | null {
  if (!sp?.total) return null;
  // Requests no node answered: no voucher was signed for them.
  const none = sp.unanswered ? unansweredNote(sp.unanswered) : '';
  if (!sp.total.answers) return `nothing in the last 24 h${none ? ` · ${none}` : ''}`;
  const note = skipNote({ answers: sp.afterANodeDidNotAnswer?.answers ?? 0, nodes: sp.afterANodeDidNotAnswer?.nodes ?? 0, resumed: sp.finishedByAnotherNode ?? 0 });
  return `$${sp.total.usd} for ${sp.total.answers} answer${sp.total.answers === 1 ? '' : 's'} in the last 24 h${note ? ` · ${note}` : ''}${none ? ` · ${none}` : ''}`;
}

/** What the router keeps in its folder on this computer, counted from the files: the answers it paid for, the
 * requests no node answered, the nodes it has its own record of, its channels. None of it holds a prompt or an
 * answer: models, token counts, prices and timings. Null when there is no such folder. */
export function keptLine(dir: string): Check | null {
  if (!existsSync(dir)) return null;
  const n = (x: number, one: string, many: string) => `${x.toLocaleString('en-US')} ${x === 1 ? one : many}`;
  const read = (file: string) => { try { return JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown; } catch { return null; } };
  const keys = (j: unknown) => (j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j).length : 0);
  // channels.json holds { channels: [...], spend }: the channels are the list.
  const ch = read('channels.json') as { channels?: unknown[] } | null;
  const parts = [n(readTrips(join(dir, 'trips.jsonl')).length, 'answer', 'answers'), n(readUnanswered(join(dir, 'unanswered.jsonl')).length, 'unanswered request', 'unanswered requests'), `a record of ${n(keys(read('observed.json')), 'node', 'nodes')}`, n(Array.isArray(ch?.channels) ? ch.channels.length : 0, 'channel', 'channels')];
  return { ok: null, what: 'kept here', detail: `${dir}: ${parts.join(', ')} · models, token counts, prices and timings, never a prompt or an answer` };
}

export async function doctor(o: { rpc: string; mint: PublicKey; wallet?: PublicKey; walletFile?: boolean; session?: PublicKey; router: string; deposit: bigint; allowDev?: boolean; version?: string; pins?: string; routerHome?: string; installed?: string | null }): Promise<Check[]> {
  const out: Check[] = [];
  if (o.version) {
    out.push(versionCheck(o.version, await latestOnNpm()));
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
  // The router's own record of the nodes it watched is read (never written): an RPC that will not list the program does
  // not leave doctor blind to the nodes this router knew.
  const registry = new Registry(conn, { allowDev: o.allowDev ?? false, measurements: [] }, undefined, o.routerHome ? join(o.routerHome, 'watched.json') : undefined);
  t0 = Date.now();
  const unlisted = await registry.refresh().then(() => null, (e) => (e as Error).message);
  const entries = [...registry.entries.values()];
  const up: { name: string; endpoint: string }[] = [];
  const privacy: { wire: boolean; inside: boolean; enclave: boolean }[] = [];
  out.push(unlisted ? { ok: false, what: 'listings', detail: unlisted } : { ok: entries.some((e) => e.account.active && e.manifest && !e.problem), what: 'listings', detail: listingsDetail(entries.length, registry.discovery, registry.fromRecord.size, ms(t0)) });
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
    privacy.push({ wire: !!e.wire, inside: !!e.wire && !!e.wireInside, enclave: !!e.tee?.verified });
    if (e.tee) out.push({ ok: e.tee.verified ? true : e.tee.dev ? null : false, what: '    enclave', detail: `${TEE_KINDS[e.account.teeKind] ?? 'enclave'} · ${e.tee.verified ? `${e.tee.reason}; :private can use this node` : `not verified: ${e.tee.reason}`}` });
  }
  // What a node sees of this computer: the first node that says is asked, through the proxy when one is set.
  if (up.length) {
    const said = await askSeen(up);
    out.push(seenCheck(said?.name ?? null, said?.seen ?? null, nodeProxy(), ownAddresses()));
  }
  if (privacy.length) out.push(privacyLine(privacy, !!nodeProxy()));

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
  const status = await fetchWithTimeout(`${o.router.replace(/\/$/, '')}/orrery/status`, { timeoutMs: 2_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { version?: string | null; privacy?: { pace?: Pace } | null; peers?: { url: string; pinned: boolean; by: string | null; signed: boolean; nodes: number; refused: string | null; at?: number; missed?: number; via?: string | null; retryAt?: number | null; relayPort?: number | null; relayOpen?: number | null; relayFull?: boolean | null; relayHolders?: boolean | null; unlisted?: number }[]; relay?: { port: number | null; relayed: number; refused: number; open?: number; perClient?: number; peersOnly?: boolean; bytes?: number; today?: number; maxBytes?: number | null; forHolders?: number } | null; discovery?: string | null; rpcLeftOut?: number; route?: string; channels?: unknown[]; agents?: { name: string; cap: string | null; spent: string; left: string | null; models?: string[] }[]; providers?: { name: string | null; address: string; found?: string; watched?: Watched | null; observed?: { ok: number; fail: number; broke?: number } | null; peers?: PeerSum | null }[]; holder?: { line?: string | null; lane?: boolean; share?: string } | null } | null;
  out.push(status ? { ok: true, what: 'router', detail: `running at ${o.router}${status.version ? `, orrery-node ${status.version}` : ''}, route ${status.route}, ${n(status.channels?.length ?? 0, 'channel')}` } : { ok: null, what: 'router', detail: routerMissing(o.router, !!o.walletFile) });
  // With a router running, the privacy line also says how its sealed answers come back, as the router's own line does.
  if (status?.privacy?.pace && privacy.length) {
    const at = out.findIndex((l) => l.what === 'privacy');
    if (at >= 0) out[at] = privacyLine(privacy, !!nodeProxy(), status.privacy.pace);
  }
  // A router started before an update keeps the old code until it is started again: npm install changes the files only.
  const behind = routerBehind(status?.version, o.installed === undefined ? PACKAGE_VERSION : o.installed);
  if (behind) out.push({ ok: null, what: '  release', detail: behind });
  // The peer routers it reads, the relay it runs and how it found the listings: the console's Peers section, in lines.
  // The peers in one line first, then a line for each in the order orrery peers lists them.
  if (status?.peers?.length) {
    const c = peersSummary(status.peers);
    out.push({ ok: null, what: '  peer routers', detail: `${c.peers} peer router${c.peers === 1 ? '' : 's'}: ${c.signed} signed, ${c.met} met through a peer, ${c.refused} refused, ${c.relaying} relaying${fullRelaysText(status.peers)}` });
  }
  for (const p of byTrust(status?.peers ?? [])) out.push({ ok: p.refused || p.at === 0 ? false : null, what: '  peer', detail: peerLine(p) });
  if (status?.relay) out.push({ ok: null, what: '  relay', detail: relayLine(status.relay) });
  const relayRouters = (status?.relay as { routersToday?: number } | null | undefined)?.routersToday ?? 0;
  if (relayRouters) out.push({ ok: null, what: '  relay today', detail: routersTodayLine(relayRouters) });
  const via = status as { peerRelay?: string | null; peerRelays?: string[]; proxyViaPeers?: boolean; spreadRelays?: boolean } | null;
  if ((via?.peerRelays?.length ?? 0) > 1) out.push({ ok: null, what: '  nodes via', detail: spreadLine(via!.peerRelays!) });
  else if (via?.peerRelay) out.push({ ok: null, what: '  nodes via', detail: `${via.peerRelay}, a peer's relay (--proxy-via-peers): the nodes see that router, not this computer${via.spreadRelays ? SPREAD_WAITS : ''}` });
  else if (via?.proxyViaPeers) out.push({ ok: null, what: '  nodes via', detail: noPeerRelayLine((status?.peers ?? []).filter((p) => ((p as { relayDownFor?: number | null }).relayDownFor ?? 0) > 0).length) });
  const lan = (status as { lan?: { listening: string | null; heard: number } | null } | null)?.lan;
  if (lan) {
    const near = ((status?.providers ?? []) as { address: string; name?: string | null; lan?: { url: string } | null }[]).filter((p) => p.lan).map((p) => ({ name: p.name ?? `${p.address.slice(0, 6)}…`, url: p.lan!.url }));
    out.push({ ok: null, what: '  this network', detail: lanDoctorLine(lan, near) });
  }
  const map = mapLine(status?.providers ?? []);
  if (map && (status?.peers?.length || status?.discovery !== 'chain')) out.push({ ok: null, what: '  map', detail: map });
  if (status?.discovery === 'peers') out.push({ ok: null, what: '  listings', detail: 'found from the peers\u2019 notes, each checked on chain (this RPC does not list the program\u2019s accounts)' });
  else if (status?.discovery === 'record') out.push({ ok: null, what: '  listings', detail: RECORD_LINE });
  else if (status?.rpcLeftOut) out.push({ ok: null, what: '  listings', detail: rpcLeftOutLine(status.rpcLeftOut) });
  // Where the router's wallet stands on holder prices, as its console says it.
  if (status?.holder?.line) out.push({ ok: null, what: '  holder price', detail: status.holder.line });
  if (status?.holder && typeof status.holder.lane === 'boolean') out.push({ ok: null, what: '  holder lane', detail: holderLaneLine(status.holder.lane, status.holder.share ?? '?') });
  // Each agent's day on this router: its limit, what it spent and has left, and the models it is kept to.
  for (const a of status?.agents ?? []) out.push({ ok: null, what: '  agent', detail: agentDayLine(a) });
  // What the running router has seen for itself: how many of its own checks found each node up.
  for (const p of status?.providers ?? []) {
    const said = watchedText(p.watched);
    if (said) out.push({ ok: null, what: '  watched', detail: `${p.name ?? `${p.address.slice(0, 6)}…`} ${said}` });
    // And what the node did with the requests this router sent it.
    const asked = answeredText(p.watched) || answeredText(p.observed);
    if (asked) out.push({ ok: null, what: '  asked', detail: `${p.name ?? `${p.address.slice(0, 6)}…`} ${asked}` });
    // And what peer routers saw of it, when this router reads any.
    const peers = peerText(p.peers);
    if (peers) out.push({ ok: null, what: '  peers', detail: `${p.name ?? `${p.address.slice(0, 6)}…`}: ${peers}` });
  }
  // What it paid in the last day, by its own log, and what it did not pay for.
  if (status) {
    const spent = await fetchWithTimeout(`${o.router.replace(/\/$/, '')}/orrery/spend?since=24h`, { timeoutMs: 2_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as Spent | null;
    // And how fast each node started answering, timed by this router.
    for (const line of speedLines(spent)) out.push({ ok: null, what: '  speed', detail: line });
    // And whether each node's bills were within the prices it listed.
    for (const line of billsLines(spent)) out.push({ ok: null, what: '  bills', detail: line });
    const paid = paidLine(spent);
    if (paid) out.push({ ok: null, what: '  paid', detail: paid });
  }
  const kept = o.routerHome ? keptLine(o.routerHome) : null;
  if (kept) out.push(kept);
  return out;
}

/** "researcher: $0.000018 of $0.000020 spent today (UTC), $0.000002 left; may use llama-3.3-70b" */
export function agentDayLine(a: { name: string; cap: string | null; spent: string; left: string | null; models?: string[] }): string {
  const day = a.cap === null ? `$${a.spent} spent today (UTC), no limit` : `$${a.spent} of $${a.cap} spent today (UTC), ${a.left !== null && Number(a.left) > 0 ? `$${a.left} left` : 'nothing left until 00:00 UTC'}`;
  return `${a.name}: ${day}${a.models?.length ? `; may use ${a.models.join(', ')}` : ''}`;
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

/** Set to 1, doctor and provider check skip the npm update check. */
export const NO_UPDATE_CHECK = 'ORRERY_NO_UPDATE_CHECK';
export const updateCheckOff = (env: NodeJS.ProcessEnv = process.env) => env[NO_UPDATE_CHECK] === '1';

/** The newest orrery-node on npm, null when npm did not answer, or 'off' when the check is turned off. */
export async function latestOnNpm(env: NodeJS.ProcessEnv = process.env): Promise<string | null | 'off'> {
  if (updateCheckOff(env)) return 'off';
  return await fetchNode('https://registry.npmjs.org/orrery-node/latest', { timeoutMs: 3_000 }).then((r) => (r.ok ? r.json() : null)).then((j) => (j as { version?: string } | null)?.version ?? null).catch(() => null);
}

/** The relay as `orrery doctor` says it: what it carried and refused, and, from a router that says them, the connections
 * open now and the limit for one address. */
export { bytesText, rpcLeftOutLine };

/** --lan-listen as `orrery doctor` says it: where the router listens, how many listings it heard on its network, and
 * which nodes it reaches there directly (only those whose listing's node key signed where they are). */
export function lanDoctorLine(lan: { listening: string | null; heard: number }, near: { name: string; url: string }[]): string {
  const at = lan.listening ?? '?';
  if (!lan.heard) return `listening on ${at} (UDP) for nodes on this network; none has said where it is yet: a node joins with orrery provider start --lan-announce <this computer>:${at.split(':').pop()} (or the network's broadcast address)`;
  const reached = near.length ? `${near.length} reached there directly: ${near.map((x) => `${x.name} at ${x.url}`).join(', ')}` : 'none reached there yet';
  const rest = lan.heard - near.length;
  return `listening on ${at} (UDP): ${lan.heard} listing${lan.heard === 1 ? '' : 's'} heard on this network, ${reached}${rest > 0 ? `; the other ${rest} not used (no such listing on chain, or not signed by the node key on it)` : ''}`;
}

/** How many routers this router's relay carried today, as a count only. */
export function routersTodayLine(n: number): string {
  return `this router's relay carried connections for ${n} router${n === 1 ? '' : 's'} today (a count only: no address is kept past the day or shown)`;
}

export function relayLine(r: { port: number | null; relayed: number; refused: number; open?: number; perClient?: number; peersOnly?: boolean; bytes?: number; today?: number; maxBytes?: number | null; forHolders?: number }): string {
  const now = r.open !== undefined && r.perClient !== undefined ? `, ${r.open} open now (up to ${r.perClient} at a time for one address)` : '';
  const size = typeof r.bytes === 'number' && r.bytes > 0 ? ` (${bytesText(r.bytes)})` : '';
  const cap = r.maxBytes ? `, ${bytesText(r.today ?? 0)} of ${bytesText(r.maxBytes)} today` : '';
  const lane = r.forHolders ? `, ${r.forHolders} carried for $OREY holders past it` : '';
  return `open on port ${r.port ?? '?'}: carried ${r.relayed}${size}, refused ${r.refused}${now}${cap}${lane} (listed nodes only${r.peersOnly ? ', for peer routers only' : ''})`;
}

/** One peer router as `orrery doctor` says it: where, who signed its notes, how many nodes, or why it was refused. */
export function peerLine(p: { url: string; pinned: boolean; by: string | null; signed: boolean; nodes: number; refused: string | null; at?: number; missed?: number; via?: string | null; retryAt?: number | null; relayPort?: number | null; relayOpen?: number | null; relayFull?: boolean | null; relayHolders?: boolean | null; unlisted?: number; name?: string | null; kept?: boolean; say?: number | null; written?: number | null }, now = Date.now()): string {
  const at = p.name ? `${p.name} (${p.url})` : p.url;
  const via = p.via ? `, met through ${p.via}` : '';
  if (p.refused) return `${at}: refused, ${p.refused}${via}`;
  const missed = p.missed ?? 0;
  const later = p.retryAt && p.retryAt > now ? `; next read in ${Math.max(1, Math.ceil((p.retryAt - now) / 60_000))} min` : '';
  if (p.at === 0) return `${at}: no answer yet (${missed} read${missed === 1 ? '' : 's'} tried${later})${via}`;
  const who = p.signed && p.by ? `signed by ${p.by.slice(0, 4)}\u2026${p.by.slice(-4)}${p.pinned ? ' (pinned)' : ''}` : 'unsigned';
  const quiet = missed ? `; no answer to the last ${missed === 1 ? 'read' : `${missed} reads`}, these notes are kept for up to an hour${later}` : '';
  const busy = [typeof p.relayOpen === 'number' ? `${p.relayOpen} open now` : '', p.relayFull ? (p.relayHolders ? 'full for today, $OREY holders still ride' : 'full for today') : ''].filter(Boolean).join(', ');
  const load = busy ? ` (${busy})` : '';
  const relays = p.relayPort ? `; relays on port ${p.relayPort}${load}, usable as --proxy http://<its host>:${p.relayPort}` : '';
  const unlisted = p.unlisted ? `, ${p.unlisted} of them not listed on chain (not used)` : '';
  const kept = p.kept && p.at ? `, kept from before the restart (written ${Math.max(1, Math.round((now - p.at) / 60_000))} min ago)` : '';
  const age = p.written && now - p.written > 600_000 ? ` (notes ${Math.round((now - p.written) / 60_000)} min old)` : '';
  const say = typeof p.say === 'number' && p.say < 1 ? `; counts ${Math.round(p.say * 100)}% under --trust-peers${age}` : '';
  return `${at}: ${who}, notes on ${p.nodes} node${p.nodes === 1 ? '' : 's'}${unlisted}${kept}${via}${say}${relays}${quiet}`;
}

/** A running router older than the release installed where doctor runs. Asks npm nothing. */
export function routerBehind(running: string | null | undefined, here: string | null): string | null {
  if (!running || !here || !newer(running, here)) return null;
  return `${running} is running; ${here} is installed here: stop the router and start it again to run ${here}`;
}

export function versionCheck(current: string, latest: string | null | 'off'): Check {
  if (latest === 'off') return { ok: null, what: 'version', detail: `${current}; not checked against npm (${NO_UPDATE_CHECK}=1)` };
  if (!latest) return { ok: null, what: 'version', detail: `${current}; npm did not answer` };
  if (newer(current, latest)) return { ok: null, what: 'version', detail: `${current}; ${latest} is on npm: npx -y orrery-node@latest` };
  if (newer(latest, current)) return { ok: true, what: 'version', detail: `${current}, ahead of npm (${latest})` };
  return { ok: true, what: 'version', detail: `${current}, the latest on npm` };
}

export function render(lines: Check[]): string {
  return lines.map((l) => `${l.ok === true ? '✓' : l.ok === false ? '✗' : '·'} ${l.what.padEnd(14)} ${l.detail}`).join('\n');
}

type PeerRow = { url: string; pinned: boolean; by: string | null; signed: boolean; nodes: number; refused: string | null; readMs?: number | null; relayDownFor?: number | null; relayHoldersOnly?: boolean | null; at?: number; missed?: number; via?: string | null; retryAt?: number | null; relayPort?: number | null; relayOpen?: number | null; relayFull?: boolean | null; relayHolders?: boolean | null; unlisted?: number; name?: string | null; kept?: boolean; say?: number | null; written?: number | null };

/** The counts `orrery peers` heads its list with, and gives under --json. */
export function peersSummary(peers: PeerRow[]): { peers: number; signed: number; met: number; refused: number; relaying: number } {
  return {
    peers: peers.length,
    signed: peers.filter((p) => p.signed && !p.refused).length,
    met: peers.filter((p) => p.via).length,
    refused: peers.filter((p) => p.refused).length,
    relaying: peers.filter((p) => p.relayPort).length,
  };
}

/** Whether this router's wallet rides $OREY holder lanes: a peer relay past its daily limit still carries a router whose
 * wallet holds at least 0.01% of the supply. */
export function holderLaneLine(lane: boolean, share: string): string {
  return lane
    ? `this wallet holds ${share} of $OREY, past the 0.01% that rides holder lanes: peer relays that carry holders take it past their daily limit (--proxy-via-peers)`
    : `0.01% of $OREY's supply (100k) rides holder lanes on peer relays past their daily limit; this wallet holds ${share}`;
}

/** How this router's own requests reach the nodes now, when it goes through its peers: one peer's relay, spread over
 * several, or its own way because none can take it. Null when --proxy-via-peers is off. */
export function nodesViaLine(status: { peerRelay?: string | null; peerRelays?: string[]; proxyViaPeers?: boolean; spreadRelays?: boolean; peers?: PeerRow[] }): string | null {
  if ((status.peerRelays?.length ?? 0) > 1) return `your requests to nodes: ${spreadLine(status.peerRelays!)}`;
  if (status.peerRelay) return `your requests to nodes: through ${status.peerRelay}, a peer's relay (--proxy-via-peers); the nodes see that router, not this computer${status.spreadRelays ? SPREAD_WAITS : ''}`;
  if (status.proxyViaPeers) return `your requests to nodes: ${noPeerRelayLine((status.peers ?? []).filter((p) => (p.relayDownFor ?? 0) > 0).length)}`;
  return null;
}

/** Under --spread-relays, which relay each node goes through, one line each. */
export function spreadByNode(providers: FoundRow[]): string[] {
  return providers.filter((p) => p.via).map((p) => `  ${p.name ?? p.address} \u2192 ${p.via}`);
}

/** Under --spread-relays with a single relay to use: the spreading starts with the second. */
export const SPREAD_WAITS = '; --spread-relays spreads them as soon as a second signed peer offers a relay';

/** --spread-relays: the peer relays the nodes are spread over. */
export function spreadLine(relays: string[]): string {
  return `spread over ${relays.length} peer relays (--spread-relays): ${relays.join(', ')}; each node is always reached through the same one, so no single peer sees all of this router's traffic`;
}

/** --proxy-via-peers is on but no signed peer offers a relay that takes connections now. */
export function noPeerRelayLine(passedOver = 0): string {
  const why = passedOver ? ` (${passedOver} passed over for a few minutes after it could not be reached)` : '';
  return `--proxy-via-peers is on, but no signed peer offers a relay that takes connections now${why}, so the nodes are reached the router's own way (directly, or through --proxy); orrery peers --relays lists what the peers offer`;
}

/** `orrery peers --relays`: the peers' relays this router could point --proxy at, least busy first (between relays as
 * busy, the peer that answered quicker), each as the --proxy
 * it would take (the peer's host, the relay's port). Relays full for today are left out and said, except, for a router
 * whose wallet rides the $OREY holder lanes, those that still carry holders; refused peers and peers that never
 * answered are not offered. */
export function relayChoices(peers: PeerRow[], holder = false, inUse: string[] = []): string[] {
  const running = peers.filter((p) => p.relayPort && !p.refused && (p.at ?? 0) > 0);
  const lane = (p: PeerRow) => !!p.relayFull && holder && !!p.relayHolders;
  const isDown = (p: PeerRow) => (p.relayDownFor ?? 0) > 0;
  const shut = (p: PeerRow) => !!p.relayHoldersOnly && !holder;
  const full = running.filter((p) => p.relayFull && !lane(p) && !isDown(p) && !shut(p));
  const down = running.filter((p) => isDown(p) && !shut(p));
  const holdersOnlyOut = running.filter(shut);
  const offer = (p: PeerRow) => ({ holderLane: lane(p), open: p.relayOpen ?? null, ms: p.readMs ?? null, signed: p.signed });
  const usable = running.filter((p) => (!p.relayFull || lane(p)) && !isDown(p) && !shut(p)).sort((a, b) => relayOrder(offer(a), offer(b)));
  if (!running.length) return ['No peer offers a relay yet. A peer started with --relay <port> offers one; until then your router reaches the nodes itself (or through your own --proxy).'];
  const host = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '<its host>';
    }
  };
  const out: string[] = [];
  if (usable.length) {
    out.push(`${usable.length} peer relay${usable.length === 1 ? '' : 's'} you can use, least busy first:`);
    for (const p of usable) {
      const using = inUse.includes(`http://${host(p.url)}:${p.relayPort}`);
      const about = [p.name ?? p.url, p.via ? `met through ${p.via}` : '', typeof p.relayOpen === 'number' ? `${p.relayOpen} open now` : '', lane(p) ? 'full for today, carries you as a $OREY holder' : '', p.relayHoldersOnly ? 'for $OREY holders only' : '', p.signed ? '' : 'unsigned', (p.missed ?? 0) > 0 ? 'quiet' : ''].filter(Boolean).join(', ');
      out.push(`  --proxy http://${host(p.url)}:${p.relayPort}  (${about})${using ? '  \u2190 in use now' : ''}`);
    }
  } else out.push('No peer relay can take new connections right now.');
  if (full.length) out.push(`${full.length} full for today, left out: ${full.map((p) => p.url).join(', ')}`);
  if (down.length) out.push(relayDownLine(down.map((p) => ({ url: p.url, seconds: p.relayDownFor ?? 0 }))));
  if (holdersOnlyOut.length) out.push(`${holdersOnlyOut.length} for $OREY holders only, left out: ${holdersOnlyOut.map((p) => p.url).join(', ')} (a router whose wallet holds 0.01% of the supply can use ${holdersOnlyOut.length === 1 ? 'it' : 'them'})`);
  if (usable.length) out.push('Start your router with one as --proxy and the nodes see that router, not this computer.');
  const signedUsable = usable.filter((p) => p.signed).length;
  if (signedUsable >= 2) out.push(spreadHintLine(signedUsable));
  return out;
}

/** The peers whose relay could not be reached when this router last used it: passed over for a few minutes each. */
export function relayDownLine(down: { url: string; seconds: number }[]): string {
  return `${down.length} could not be reached and ${down.length === 1 ? 'is' : 'are'} passed over for now: ${down.map((d) => `${d.url} (${Math.max(1, Math.ceil(d.seconds / 60))} more min)`).join(', ')}`;
}

/** `orrery peers --relays --json`: every relay the peers offer as data, the ones a router could use now first (in the
 * order --proxy-via-peers weighs them), with why the others are left out. */
export type RelayRow = { proxy: string | null; peer: string; name: string | null; open: number | null; readMs: number | null; signed: boolean; usable: boolean; full: boolean; holderLane: boolean; holdersOnly: boolean; downFor: number | null; inUse: boolean };
export function relayChoicesJson(peers: PeerRow[], holder = false, inUse: string[] = []): { relays: RelayRow[]; inUse: string[] } {
  const running = peers.filter((p) => p.relayPort && !p.refused && (p.at ?? 0) > 0);
  const lane = (p: PeerRow) => !!p.relayFull && holder && !!p.relayHolders;
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };
  const rows: RelayRow[] = running.map((p) => {
    const h = hostOf(p.url);
    const proxy = h ? `http://${h}:${p.relayPort}` : null;
    const down = (p.relayDownFor ?? 0) > 0;
    const onlyHolders = !!p.relayHoldersOnly;
    return { proxy, peer: p.url, name: p.name ?? null, open: p.relayOpen ?? null, readMs: p.readMs ?? null, signed: p.signed, usable: (!p.relayFull || lane(p)) && !down && (!onlyHolders || holder), full: !!p.relayFull, holderLane: lane(p), holdersOnly: onlyHolders, downFor: down ? p.relayDownFor ?? null : null, inUse: !!proxy && inUse.includes(proxy) };
  });
  rows.sort((a, b) => Number(b.usable) - Number(a.usable) || relayOrder({ holderLane: a.holderLane, open: a.open, ms: a.readMs, signed: a.signed }, { holderLane: b.holderLane, open: b.open, ms: b.readMs, signed: b.signed }));
  return { relays: rows, inUse };
}

/** Under orrery peers --relays, when two or more signed peers offer a relay: --spread-relays would use all of them. */
export function spreadHintLine(n: number): string {
  return `Or start it with --proxy-via-peers --spread-relays: it uses all ${n} of these signed peers' relays, each node always through the same one, so no single peer sees all of your traffic.`;
}

/** How many of the peers' relays say they are full for today, for the summary line: " (1 full for today)", or nothing. */
export function fullRelaysText(peers: PeerRow[]): string {
  const n = peers.filter((p) => p.relayPort && p.relayFull).length;
  return n ? ` (${n} full for today)` : '';
}

/** Peers in the order an operator reads them: the ones given and answering first, then those met through a peer, those
 * gone quiet, those that never answered, and the refused last; signed before unsigned within each. */
export function byTrust<T extends PeerRow>(peers: T[]): T[] {
  const rank = (p: PeerRow) => (p.refused ? 4 : p.at === 0 ? 3 : (p.missed ?? 0) > 0 ? 2 : p.via ? 1 : 0) * 2 + (p.signed ? 0 : 1);
  return [...peers].sort((a, b) => rank(a) - rank(b));
}

/** doctor's listings line: how many, and when the RPC did not give them all, how many came from the router's own record. */
export function listingsDetail(n: number, discovery: string | null, fromRecord: number, took: string): string {
  if (discovery === 'record') return `${n} from this router\u2019s own record of the nodes it watched, each read on chain (this RPC does not list the program\u2019s accounts), read in ${took}`;
  return `${n} on chain${fromRecord ? `, ${fromRecord} of them only in this router\u2019s own record (the RPC\u2019s list left ${fromRecord === 1 ? 'it' : 'them'} out)` : ''}, read in ${took}`;
}

/** Where the listings came from when the RPC will not list the program and no peer named any: the router's own record. */
export const RECORD_LINE = 'the listings came from this router\u2019s own record of the nodes it watched before, each checked on chain (this RPC does not list the program\u2019s accounts; add a peer router with --peer to find new ones)';

export type FoundRow = { address: string; name?: string | null; found?: string; via?: string | null; peers?: { routers: number } | null };

/** The listings a router has only because its peers named them, one line each with how many peers named it: the part of
 * its map the peers drew. At most ten, then how many more. */
export function foundThroughPeers(providers: FoundRow[], most = 10): string[] {
  const through = providers.filter((p) => p.found === 'peers');
  const kept = providers.filter((p) => p.found === 'record').length;
  const recordLine = kept ? [`  ${kept} listing${kept === 1 ? '' : 's'} only in this router\u2019s own record of the nodes it watched before, read on chain`] : [];
  if (!through.length) return recordLine;
  const line = (p: FoundRow) => {
    const n = p.peers?.routers ?? 0;
    return `  ${p.name ? `${p.name} (${p.address.slice(0, 4)}\u2026${p.address.slice(-4)})` : p.address}: found through peers${n ? `, named by ${n} peer router${n === 1 ? '' : 's'}` : ''}, read on chain`;
  };
  return [...through.slice(0, most).map(line), ...(through.length > most ? [`  and ${through.length - most} more found through peers`] : []), ...recordLine];
}

/** Where the router's map of the network came from, in one line: how many listings it has, and how many of them are in
 * the RPC's list, from peers (named by peer routers, read on chain), or only in its own record. Null when it has none. */
export function mapLine(providers: FoundRow[]): string | null {
  if (!providers.length) return null;
  const n = (f: string) => providers.filter((p) => (p.found ?? 'rpc') === f).length;
  const [rpc, peers, record] = [n('rpc'), n('peers'), n('record')];
  const parts = [rpc ? `${rpc} in the RPC's list` : "none in the RPC's list", peers ? `${peers} from peers` : '', record ? `${record} from this router's own record` : ''].filter(Boolean);
  return `the map: ${providers.length} listing${providers.length === 1 ? '' : 's'}, ${parts.join(', ')}`;
}

/** `orrery peers`: the P2P side of a running router in one place, from its own status. Each peer router (who signed its
 * notes, which peer introduced it, whether it relays), a count of them, this router's relay, and where the listings
 * came from. A router that reads no peers is told how to start. */
export function peersReport(status: { peers?: PeerRow[]; relay?: { port: number | null; relayed: number; refused: number; open?: number; perClient?: number; peersOnly?: boolean; bytes?: number; today?: number; maxBytes?: number | null; forHolders?: number } | null; discovery?: string | null; rpcLeftOut?: number; providers?: FoundRow[] ; peerRelay?: string | null; peerRelays?: string[]; proxyViaPeers?: boolean; spreadRelays?: boolean}, now = Date.now()): string[] {
  const peers = status.peers ?? [];
  const out: string[] = [];
  if (!peers.length) {
    out.push('This router reads no peer routers. Start it with --peer <url>#<key> to read another router\u2019s notes on nodes, and --meet-peers to meet the routers that one reads.');
  } else {
    const c = peersSummary(peers);
    out.push(`${c.peers} peer router${c.peers === 1 ? '' : 's'}: ${c.signed} signed, ${c.met} met through a peer, ${c.refused} refused, ${c.relaying} relaying${fullRelaysText(peers)}`);
    for (const p of byTrust(peers)) out.push(`  ${peerLine(p, now)}`);
  }
  out.push(status.relay ? `this router's relay: ${relayLine(status.relay)}` : 'this router runs no relay (start it with --relay <port> to carry other routers\u2019 traffic to listed nodes)');
  const carriedFor = (status.relay as { routersToday?: number } | null | undefined)?.routersToday ?? 0;
  if (carriedFor) out.push(routersTodayLine(carriedFor));
  const route = nodesViaLine(status);
  if (route) out.push(route);
  if ((status.peerRelays?.length ?? 0) > 1) out.push(...spreadByNode(status.providers ?? []));
  const map = mapLine(status.providers ?? []);
  if (map) out.push(map);
  if (status.discovery === 'peers') out.push('the listings came from the peers\u2019 notes, each checked on chain');
  else if (status.discovery === 'record') out.push(RECORD_LINE);
  else if (status.rpcLeftOut) out.push(rpcLeftOutLine(status.rpcLeftOut));
  out.push(...foundThroughPeers(status.providers ?? []));
  return out;
}

/** How many of the nodes a router names are already on this router's map, and how many it would bring. */
export function newToMapLine(named: string[], mine: Set<string>): string {
  const all = [...new Set(named)];
  const fresh = all.filter((a) => !mine.has(a)).length;
  const have = all.length - fresh;
  if (!fresh) return all.length === 1 ? 'the node it names is on your map already' : `all ${all.length} nodes it names are on your map already`;
  return `${!have ? (all.length === 1 ? 'the node it names is' : `all ${all.length} nodes it names are`) : `${fresh} of the ${all.length} nodes it names ${fresh === 1 ? 'is' : 'are'}`} not on your map yet${have ? ` (${have} already ${have === 1 ? 'is' : 'are'})` : ''}: once added, your router reads ${fresh === 1 ? 'it' : 'each'} on chain and keeps ${fresh === 1 ? 'it only if it is a listing' : 'only the ones that are listings'}`;
}

/** `orrery peers --check <url[#key]>`: what this router would make of a router before it is added as a peer, from its
 * notes and its /orrery/peers as they came back (or why nothing did). Ok is false when its notes would be refused or it
 * did not answer. Nothing is kept. With `mine` (the listings on the local router's map), it also says how many of the
 * nodes it names are new to that map. */
export function peerCheck(target: string, notes: unknown, intros: unknown = null, now = Date.now(), mine: Set<string> | null = null): { ok: boolean; lines: string[] } {
  const [base, pinned] = target.split('#');
  const url = base.replace(/\/$/, '');
  if (typeof notes === 'string') return { ok: false, lines: [`${url}: no notes (${notes}); a router shares them only when started with --share-notes`] };
  const read = readPeerNotes(notes, pinned || undefined, now);
  if ('refused' in read) return { ok: false, lines: [`${url}: its notes would be refused: ${read.refused}`] };
  const at = (notes as { at?: number }).at ?? now;
  const ago = Math.max(0, Math.round((now - at) / 1000));
  const who = read.signed && read.by ? `signed by ${read.by.slice(0, 4)}\u2026${read.by.slice(-4)}` : 'unsigned';
  const lines = [`${url}: answers, ${who}, notes on ${read.nodes.length} node${read.nodes.length === 1 ? '' : 's'}, written ${ago} s ago`];
  if (pinned) lines.push(`pinned to ${pinned.slice(0, 4)}\u2026${pinned.slice(-4)}: its notes are signed by that key`);
  else if (!read.signed) lines.push('unsigned: shown beside your record, but --trust-peers will not count them');
  const port = readRelayPort(intros);
  const open = readRelayOpen(intros);
  const lane = readRelayHolders(intros) === true;
  const onlyHolders = readRelayHoldersOnly(intros) === true;
  const busy = [open !== null ? `${open} open now` : '', onlyHolders ? 'for $OREY holders only' : '', readRelayFull(intros) ? (lane ? 'full for today, $OREY holders still ride' : 'full for today') : lane ? 'keeps a lane for $OREY holders past its daily limit' : ''].filter(Boolean).join(', ');
  lines.push(port ? `relays on port ${port}${busy ? ` (${busy})` : ''}, usable as --proxy http://<its host>:${port}` : 'runs no relay');
  const named = readIntroductions(intros);
  lines.push(intros === null ? 'introduces no routers (no /orrery/peers)' : `introduces ${named.length} router${named.length === 1 ? '' : 's'}${named.length ? ', read with --meet-peers' : ''}`);
  lines.push(read.signed && read.by ? `add it with: --peer ${url}#${read.by}` : `add it with: --peer ${url} (unsigned, so it cannot be pinned)`);
  if (mine && read.nodes.length) lines.push(newToMapLine(read.nodes.map((n) => n.address), mine));
  return { ok: true, lines };
}
