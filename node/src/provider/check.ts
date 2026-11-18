// `orrery provider check`: everything a node needs to earn, looked at from the operator's side before (or after) it
// lists: the model server, the address routers will call, the listing on chain, the fee money, the enclave, the pledge.
import { readRefused, refusedCounts, refusedText } from './refusal.ts';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { decodeProvider, pda } from '../chain/program.ts';
import { usd } from '../pricing.ts';
import { Registry, readWire } from '../router/registry.ts';
import { compare, type CompareRow } from './compare.ts';
import { fetchWithTimeout } from '../sse.ts';
import { verifySnp } from '../tee/snp.ts';
import { verifyTdx } from '../tee/tdx.ts';
import { privateAddress } from '../address.ts';
import { servedContext } from './init.ts';
import { folderRisk, folderWarning } from './folder.ts';
import { FEE_FLOOR_LAMPORTS, TOKEN_ACCOUNT_BYTES, type ProviderNode } from './node.ts';

export type CheckLine = { ok: boolean | null; what: string; detail: string };

/** The address provider init writes until the operator sets a real one. */
export const PLACEHOLDER_URL = /^https?:\/\/your-node\.example\.com\/?$/;
/** What a little SOL means for a node key: one payout is one transaction at the base fee. */
const FEE_EXAMPLE = '0.01 SOL pays for about 2,000 payouts';

/** What 0.01 SOL on the node key pays for. When the first payout must open the wallet's USDC account, that rent comes
 * first, and the payouts left after it are said instead (about 1,700 on mainnet, rounded to the hundred). */
export function feeExample(accountRent: number | null): string {
  if (!accountRent) return FEE_EXAMPLE;
  const left = Math.max(0, 10_000_000 - accountRent);
  return `0.01 SOL pays for that and about ${(Math.round(left / 5_000 / 100) * 100).toLocaleString('en-US')} payouts`;
}

export { TOKEN_ACCOUNT_BYTES };

/** The node key's line. `accountRent` is the rent of the wallet's USDC account when it does not exist yet (null when
 * it does): the first payout opens it and the node's key pays that, so the key needs it on top of its fee money. A
 * key that passed this check would otherwise fail its first payout. */
export function nodeKeyLine(o: { lamports: number; accountRent: number | null; nodeKey: string }): CheckLine {
  const sol = (n: number) => (n / LAMPORTS_PER_SOL).toFixed(4);
  const ok = o.lamports >= FEE_FLOOR_LAMPORTS + (o.accountRent ?? 0);
  const opens = o.accountRent ? `; the first payout also opens your wallet’s USDC account, about ${sol(o.accountRent)} SOL once from this key` : '';
  return { ok, what: 'node key', detail: `${sol(o.lamports)} SOL for redeem fees${opens}${ok ? '' : `; send a little to ${o.nodeKey} (${feeExample(o.accountRent)}), or have the listing wallet send it: provider register --fund-key`}` };
}

/** What `provider register --fund-key` says it sent, and how many payouts that is once the first has opened the
 * wallet's USDC account, when it has to. */
export function fundKeyNote(lamports: number, nodeKey: string, accountRent: number | null): string {
  const left = Math.max(0, lamports - (accountRent ?? 0));
  return `sent ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL to the node’s key ${nodeKey} for redeem fees (about ${Math.floor(left / 5_000).toLocaleString('en-US')} payouts${accountRent ? '; the first also opens your wallet’s USDC account' : ''})`;
}

/** What provider.json lists as context beyond what the model server says it serves (max_model_len in /models), or
 * null. Clients size their prompts to the listed number, and a longer prompt fails at the server. */
export function contextNote(listed: { id: string; upstreamModel?: string; context: number }[], served: { id: string; max_model_len?: unknown }[]): string | null {
  const at = new Map(served.flatMap((m) => { const c = servedContext(m); return c ? [[m.id, c] as const] : []; }));
  const over = listed.flatMap((m) => { const c = at.get(m.upstreamModel ?? m.id); return c && m.context > c ? [{ id: m.id, listed: m.context, served: c }] : []; });
  const n = (x: number) => x.toLocaleString('en-US');
  if (!over.length) return null;
  if (over.length === 1) return `provider.json lists ${n(over[0].listed)} tokens of context for ${over[0].id}, but the model server serves ${n(over[0].served)}. Longer requests fail there and count against this node: set "context" to ${n(over[0].served)} or less`;
  const each = over.map((o) => `${o.id} (${n(o.listed)}; it serves ${n(o.served)})`);
  return `provider.json lists more context than the model server serves for ${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}. Longer requests fail there and count against this node: set each "context" to what the server serves`;
}

/** Listings whose maxOutput leaves no room for a prompt in their context, or null. A request that leaves max_tokens
 * to the node gets maxOutput, and the model server refuses a prompt plus that much beyond its context. Embedding
 * models (priced on input only) write no output and are left alone. */
export function roomNote(models: { id: string; context: number; maxOutput: number; price: { output: number } }[]): string | null {
  const n = (x: number) => x.toLocaleString('en-US');
  const tight = models.filter((m) => m.price.output > 0 && m.context > 0 && m.maxOutput >= m.context);
  if (!tight.length) return null;
  const what = tight.length === 1
    ? `${tight[0].id} lists a maxOutput of ${n(tight[0].maxOutput)} in a context of ${n(tight[0].context)}`
    : `${tight.slice(0, -1).map((m) => `${m.id} (maxOutput ${n(m.maxOutput)}, context ${n(m.context)})`).join(', ')} and ${(([m]) => `${m.id} (maxOutput ${n(m.maxOutput)}, context ${n(m.context)})`)(tight.slice(-1))} list a maxOutput as large as their context`;
  return `${what}: nothing is left for the prompt, so a request that leaves max_tokens to the node fails at the model server. Set maxOutput to a quarter of context or less${tight.length === 1 ? ` (${n(Math.max(1, Math.floor(tight[0].context / 4)))})` : ''}`;
}

export type ListingState = 'listed' | 'missing' | 'closed' | 'prices_changed' | 'address_changed';

/** Where this node's listing stands on chain against what its provider.json says. */
export function listingState(acct: { active: boolean; manifestHash: Uint8Array; endpoint: string } | null, node: { manifestHash: Buffer; publicUrl: string }): ListingState {
  if (!acct) return 'missing';
  if (!acct.active) return 'closed';
  if (!node.manifestHash.equals(acct.manifestHash)) return 'prices_changed';
  return acct.endpoint === node.publicUrl ? 'listed' : 'address_changed';
}

/** The line `provider status` prints for it: what the state means for routers, and the command that clears it. */
export function listingLine(state: ListingState, o: { config: string; endpoint?: string }): string {
  const register = `orrery provider register --config ${o.config}`;
  const said: Record<ListingState, string> = {
    listed: 'on chain, with this node’s prices and address',
    missing: `not on chain yet, so no router can find this node: ${register}`,
    closed: 'closed on chain, so no router uses this node',
    prices_changed: `provider.json has prices the chain does not, so a router reading them now refuses this node: ${register}`,
    address_changed: `on chain under ${o.endpoint}, so routers go there: ${register}`,
  };
  return `  listing               ${said[state]}`;
}

/** Each model against the other listings of it, for the request the :cheap route compares (2,000 tokens in, 500 out):
 * the cheapest, or how many list it cheaper and the lowest, or that nobody else lists it; and, when some list it
 * cheaper, the command that suggests prices under them. Four models at most; null when there are none. */
export function pricesLine(rows: CompareRow[]): CheckLine | null {
  if (!rows.length) return null;
  const say = (r: CompareRow) => (!r.others ? `${r.model} listed by no other node` : !r.cheaper ? `${r.model} the cheapest of ${r.others + 1}` : r.others === 1 ? `${r.model} at $${usd(r.myCost)}, the one other listing cheaper at $${usd(r.lowestCost!)}` : `${r.model} at $${usd(r.myCost)}, ${r.cheaper} of ${r.others} other listings cheaper, the lowest $${usd(r.lowestCost!)}`);
  const more = rows.length > 4 ? `; and ${rows.length - 4} more` : '';
  const under = rows.some((r) => r.cheaper > 0) ? ' · orrery provider price suggests prices under the cheapest' : '';
  return { ok: null, what: 'prices', detail: `a 2,000-in / 500-out request: ${rows.slice(0, 4).map(say).join('; ')}${more}${under}` };
}

export async function providerCheck(node: ProviderNode): Promise<CheckLine[]> {
  const cfg = node.cfg, out: CheckLine[] = [];
  const base = cfg.upstream.baseUrl.replace(/\/$/, '');
  const key = cfg.upstream.apiKey ?? (cfg.upstream.apiKeyEnv ? process.env[cfg.upstream.apiKeyEnv] : undefined);
  const models = (await fetchWithTimeout(`${base}/models`, { timeoutMs: 5_000, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(cfg.upstream.headers ?? {}) } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { data?: { id: string; max_model_len?: unknown }[] } | null;
  if (!models) out.push({ ok: false, what: 'model server', detail: `${base} did not answer /models` });
  else {
    const have = new Set((models.data ?? []).map((m) => m.id));
    const missing = cfg.models.filter((m) => have.size && !have.has(m.upstreamModel ?? m.id)).map((m) => m.upstreamModel ?? m.id);
    out.push({ ok: missing.length ? null : true, what: 'model server', detail: missing.length ? `answers at ${base}; its /models list does not name ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} (fine if it accepts those names anyway)` : `answers at ${base}, serves all ${cfg.models.length} listed model${cfg.models.length === 1 ? '' : 's'}` });
  }
  const room = roomNote(cfg.models);
  if (room) out.push({ ok: false, what: 'max output', detail: room });
  // What the model server turned away lately, from the node's own record of it: the node's log says each one.
  const refused = refusedCounts(readRefused(`${node.dir}/refused.jsonl`), 86_400_000);
  if (Object.keys(refused).length) out.push({ ok: null, what: 'refusals', detail: `the model server refused ${refusedText(refused)} (orrery provider status shows it too; the node's log says each one)` });
  const tooLong = models ? contextNote(cfg.models, models.data ?? []) : null;
  if (tooLong) out.push({ ok: null, what: 'context', detail: tooLong });
  // Listed is not the same as answering: one small request to each model, straight to the model server.
  if (models) out.push(await modelTest(base, { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(cfg.upstream.headers ?? {}) }, cfg.models));

  const t0 = Date.now();
  const health = (await fetchWithTimeout(`${cfg.publicUrl.replace(/\/$/, '')}/health`, { timeoutMs: 5_000 }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { provider?: string } | null;
  const local = privateAddress(cfg.publicUrl);
  out.push(!health ? { ok: false, what: 'public address', detail: PLACEHOLDER_URL.test(cfg.publicUrl) ? `${cfg.publicUrl} is still the placeholder from provider init: set publicUrl to the address routers will reach` : `${cfg.publicUrl} did not answer /health (is the node running, and reachable from outside?)` }
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
  if (!acct) {
    // What listing will cost here: the rent for an account that size on this cluster, plus the fee. Read, not assumed.
    const rent = await node.conn.getMinimumBalanceForRentExemption(LISTING_BYTES).catch(() => null);
    out.push({ ok: false, what: 'listing', detail: `not on chain yet: orrery provider register --config … lists it${rent === null ? '' : ` (takes about ${((rent + 10_000) / LAMPORTS_PER_SOL).toFixed(4)} SOL once, the rent for the listing)`}` });
  }
  else {
    const state = listingState(acct, { manifestHash: node.manifestHash, publicUrl: cfg.publicUrl });
    out.push({ ok: state === 'listed', what: 'listing', detail: state === 'closed' ? 'on chain but closed' : state === 'prices_changed' ? 'your price list changed since you listed; run provider register again so routers accept it' : state === 'address_changed' ? `on chain with another address (${acct.endpoint}); run provider register again` : `on chain, price list matches, $${usd(acct.settled)} settled in ${acct.redeems} redeems` });
  }

  // Where each price stands among the other listings of the same model, as a router on this cluster reads them. A node
  // priced above every other listing of its models waits longest for its first answer; info only, never a failure.
  const network = await (async () => {
    const r = new Registry(node.conn, { allowDev: !!privateAddress(node.conn.rpcEndpoint), measurements: [] });
    await r.refresh();
    return r.usable();
  })().catch(() => null);
  const prices = network ? pricesLine(compare(cfg.models.map((m) => ({ id: m.id, price: m.price })), network, node.pda.toBase58())) : null;
  if (prices) out.push(prices);

  // Payouts go to the wallet's USDC account. A wallet made by `orrery wallet new` has none yet: the first payout opens it.
  const payoutAccount = await node.conn.getAccountInfo(pda.ata(node.authority, node.mint)).catch(() => undefined);
  const accountRent = payoutAccount === null ? await node.conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES).catch(() => null) : null;
  out.push(nodeKeyLine({ lamports: await node.conn.getBalance(node.node.publicKey), accountRent, nodeKey: node.node.publicKey.toBase58() }));

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

type TestFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
const MODELS_TESTED = 3;
const took = (ms: number) => (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`);

/** Asks each listed model one small thing (the first three), the way the node itself would: a model that is listed
 * but not loaded, not pulled or out of memory fails here, in front of the operator, and not later in front of a
 * router. A model priced on input only is an embedding model and is asked for an embedding. */
export async function modelTest(
  base: string,
  headers: Record<string, string>,
  models: { id: string; upstreamModel?: string; price: { input: number; output: number } }[],
  fetchFn: TestFetch = (url, init) => fetchWithTimeout(url, { ...init, timeoutMs: 60_000 }),
): Promise<CheckLine> {
  const good: string[] = [], bad: string[] = [];
  for (const m of models.slice(0, MODELS_TESTED)) {
    const name = m.upstreamModel ?? m.id, embeds = m.price.output === 0, t0 = performance.now();
    const said = await fetchFn(`${base}/${embeds ? 'embeddings' : 'chat/completions'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(embeds ? { model: name, input: 'ok' } : { model: name, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 8, stream: false }),
    })
      .then(async (r) => {
        const text = await r.text();
        if (r.ok) return null;
        const why = (() => { try { const j = JSON.parse(text) as { error?: { message?: string } | string }; return typeof j.error === 'string' ? j.error : j.error?.message; } catch { return undefined; } })();
        return `${r.status}${why ? `: ${why.slice(0, 120)}` : ''}`;
      })
      // A model server loads a model on its first request, and a large one can take longer than this waits.
      .catch((e) => (/^timeout after/.test((e as Error).message) ? 'no answer in 60 s; a model loading for the first time can take longer, so run the check again' : (e as Error).message.slice(0, 120)));
    if (said === null) good.push(`${name} ${good.length ? '' : 'answered a test request '}in ${took(performance.now() - t0)}`);
    else bad.push(`${name} did not answer a test request (${said})`);
  }
  if (bad.length && good.length) good[0] = good[0].replace('answered a test request in', 'answered in');
  const left = models.length > MODELS_TESTED ? ` (the first ${MODELS_TESTED} of ${models.length} models)` : '';
  return { ok: bad.length === 0, what: 'model test', detail: `${[...bad, ...good].join('; ')}${left}` };
}

/** The size of a node's listing on chain; what it costs to list is the rent for an account this big, paid once. */
export const LISTING_BYTES = 419;

/** `--fund-key`: what the listing wallet sends the node's key in the register transaction, in lamports. With no amount
 * it is 0.01 SOL. More than half a SOL is refused: this is fee money, and a figure that large is a slipped digit. */
export function fundKeyLamports(text: string | undefined): number {
  if (text === undefined) return 10_000_000;
  const sol = Number(text);
  if (!Number.isFinite(sol) || sol <= 0) throw new Error('--fund-key takes an amount of SOL, such as --fund-key 0.01');
  if (sol > 0.5) throw new Error(`--fund-key ${text} is more than a node key needs: it only pays redeem fees (${FEE_EXAMPLE}). The most this sends is 0.5 SOL`);
  return Math.round(sol * 1e9);
}

/** How many payouts that much SOL pays for: one payout is one transaction at the base fee. */
export const payoutsFor = (lamports: number) => Math.floor(lamports / 5_000);

export { privateAddress } from '../address.ts';

/** Why `provider register` should not send its transaction, in words, or null when it can: the address is still the
 * placeholder (the listing would point routers nowhere), it is one only the operator's own network can reach while
 * the cluster is a public one (`localCluster` is a validator on this machine or network; `privateOk` is
 * --private-address), or the wallet cannot pay for it. */
export function registerProblem(o: { publicUrl: string; exists: boolean; lamports: number; rent: number; wallet: string; fund?: number; localCluster?: boolean; privateOk?: boolean }): string | null {
  if (PLACEHOLDER_URL.test(o.publicUrl)) return 'set "publicUrl" first: it is still the placeholder from provider init, and the listing would send routers to an address that is not yours';
  if (!o.localCluster && !o.privateOk && privateAddress(o.publicUrl)) return `"publicUrl" is ${o.publicUrl}, an address only machines on your own network can reach, so routers on the internet could not reach the node you would list. Set it to a public domain or IP with the node’s port open, or pass --private-address to list it for routers on your network only`;
  const fee = 10_000, sol = (n: number) => (n / 1e9).toFixed(4);
  const need = o.rent + fee + (o.fund ?? 0);
  if (o.lamports >= need) return null;
  const key = o.fund ? ` --fund-key sends the node’s key another ${sol(o.fund)} SOL: ${sol(need)} SOL in all.` : '';
  return o.exists
    ? `your wallet ${o.wallet} has ${sol(o.lamports)} SOL. Updating a listing is one transaction and needs its fee.${key} Send it a little SOL and run this again`
    : `your wallet ${o.wallet} has ${sol(o.lamports)} SOL. Listing a node takes about ${sol(o.rent + fee)} SOL, once: the rent for its listing on Solana, plus the fee.${key} Send it a little SOL and run this again`;
}

/** The one next thing to do, in the order a new node goes through them: model server, address, listing, fee money,
 * then the node itself. Nothing failing means routers can find it, reach it and pay it. */
export function nextStep(lines: CheckLine[], at: { config: string; publicUrl: string; nodeKey: string; running?: boolean; walletInConfig?: boolean; walletAway?: string; localCluster?: boolean; firstPayout?: boolean; everySecs?: number }): string {
  const bad = (what: string) => lines.find((l) => l.what === what && l.ok === false);
  // A config that names a wallet file which is there needs no --wallet: register reads it from the config.
  const register = `orrery provider register --config ${at.config}${at.walletInConfig || at.walletAway ? '' : ' --wallet <keypair.json>'}`;
  // This computer knows the wallet only by its address (a container, a cold wallet): registering is for the one that
  // has the wallet. `walletAway` is the wallet file the config names, or '' when it names none.
  const where = at.walletAway === undefined ? '' : `, on the computer that has your wallet${at.walletAway ? ` (${at.walletAway})` : ''}`;
  const server = bad('model server'), listing = bad('listing'), address = bad('public address'), lowKey = bad('node key');
  if (server) return `next: start your model server: ${server.detail}`;
  const test = bad('model test');
  if (test) return `next: get the model answering: ${test.detail}`;
  if (address && PLACEHOLDER_URL.test(at.publicUrl)) return `next: set "publicUrl" in ${at.config} to the address routers will reach (a domain or IP with this node's port open)`;
  // Not listed yet, under an address only its own network reaches, on a cluster routers reach over the internet:
  // register would refuse it, so the address comes first (--private-address lists it for that network alone).
  if (listing && /not on chain yet/.test(listing.detail) && !at.localCluster && privateAddress(at.publicUrl))
    return `next: set "publicUrl" in ${at.config} to a public domain or IP with this node’s port open: ${at.publicUrl} reaches only machines on your own network, so routers on the internet could not reach it (to list it for your own network anyway: ${register} --private-address)`;
  const cost = listing ? /takes about ([\d.]+ SOL) once/.exec(listing.detail)?.[1] : undefined;
  // A new node's key has no fee money either: the same transaction can send it, so there is one address to fund.
  if (listing) return /not on chain yet/.test(listing.detail) ? `next: list the node on chain${where}: ${register}${lowKey ? ' --fund-key' : ''} (${cost ? `one transaction from your wallet, about ${cost} once for the listing’s rent` : 'a one-time transaction from your wallet'}${lowKey ? '; --fund-key also sends the node’s key 0.01 SOL for redeem fees' : ''})` : `next: run ${register} again: ${listing.detail.split(';')[0]}`;
  // The node key line already worked out what 0.01 SOL pays for on this wallet; the next step says the same.
  if (lowKey) return `next: send a little SOL to ${at.nodeKey} for redeem fees (${/\((0\.01 SOL pays for [^)]*)\)/.exec(lowKey.detail)?.[1] ?? FEE_EXAMPLE}), or from the listing wallet: ${register} --fund-key`;
  if (address && at.running) return `next: make sure ${at.publicUrl} reaches this node from outside: it did not answer from here (orrery provider check --config ${at.config} looks again)`;
  if (address) return `next: start the node (orrery provider start --config ${at.config}, or provider compose for Docker) and make sure ${at.publicUrl} reaches it from outside`;
  const other = lines.find((l) => l.ok === false);
  if (other) return `next: ${other.what}: ${other.detail}`;
  // A node never paid out on chain sends its first payout at its next round (provider/node.ts redeemRound).
  const every = at.everySecs ?? 60;
  const when = at.firstPayout ? `. Its first payout goes out at the next round after its first answer (every ${every < 60 ? `${every} s` : `${Math.round(every / 60)} min`})` : '';
  return `ready to earn: routers can find this node, reach it and pay it${when}`;
}

export const renderCheck = (name: string, lines: CheckLine[]) => [`"${name}"`, ...lines.map((l) => `${l.ok === null ? '·' : l.ok ? '✓' : '✗'} ${l.what.padEnd(15)}${l.detail}`)].join('\n');
