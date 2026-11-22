// A provider node: sells inference from any OpenAI-compatible upstream (vLLM, SGLang, Ollama, llama.cpp, or an API
// you hold capacity on) to routers on the network. It never sees a wallet signature per request: it checks the
// router's running-total voucher, serves, meters, and redeems the highest voucher on chain when it chooses.
import { rpcConnection } from '../chain/connect.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { decodeChannel, decodeProvider, ins, pda, programId, type ChannelAccount } from '../chain/program.ts';
import { snpClaim } from '../tee/snp.ts';
import { tdxClaim } from '../tee/tdx.ts';
import { burnOnce, loadBook, type BurnReceipt, type Burner, type Swapper } from '../burn.ts';
import { sendFresh } from '../chain/send.ts';
import { decodeVoucher, redeemInstructions, verifyVoucher, type Voucher, encodeVoucher } from '../chain/voucher.ts';
import { home, loadKeypair, loadOrCreateKeypair, signerOf, writePrivate } from '../keys.ts';
import { canonical, IMAGE_TOKENS, imageCount, kindPath, manifestHash, MODEL_KINDS, speechTokens, type Manifest, type ModelKind, type ModelOffer } from '../manifest.ts';
import { checkTiers, discounted, HolderBook, type HolderTier } from '../holder.ts';
import { checkHolderSlots, checkSlots, Slots } from './slots.ts';
import { TICKER } from '../brand.ts';
import { costOf, estimateInputTokens, usd } from '../pricing.ts';
import { encrypt, enclaveKeyFromSecret, insideMessage, newEnclaveKey, openRequest, padFrame, wireMessage, type EnclaveKey } from '../seal.ts';
import { readSse, sseFrame, fetchWithTimeout } from '../sse.ts';
import { nodeTimingHeader } from '../router/timing.ts';
import { nextUsageHash, ZERO_HASH, type UsageRecord } from '../usage.ts';
import { consoleKeyPage, hasConsoleKey, isLocal, providerConsolePage } from './console.ts';
import { booksByDay, booksByDayCsv, booksNotice, dayBooksLine, dayKinds, dayToKeep, keepDay, monthBooksLine, monthNotice, monthSentence, monthSoFar, readDays, utcDay, type DayBooks, type DayKept } from './books.ts';
import { appendPayout, arrivalNote, checkPayouts, nextPayout, notifyUrl, payoutCheckLines, payoutNotice, payoutSummary, postNotice, readHeld, readNotice, readPayouts, withChecked, writeHeld, writeNotice, type Landed, type Payout, payoutFailedNotice } from './payouts.ts';
import { Reach, firstReachNote, quietNote } from './reach.ts';
import { appendRefused, readRefused, refusal, refusedCounts } from './refusal.ts';
import { seenFrom } from '../seen.ts';
import { folderWarning } from './folder.ts';
import { appendTrip, heldGivenLine, heldSaved, paidInside, readTrips, rowsByKind, summarize, windowMs } from '../spend.ts';

export type ProviderOffer = ModelOffer & { upstreamModel?: string };

export type ProviderConfig = {
  name: string;
  region?: string;
  listen: number;
  host?: string;
  publicUrl: string;
  rpcUrl: string;
  settleMint: string;
  authority?: string;
  wallet?: string;
  nodeKey?: string;
  nodeKeyEnv?: string;
  dataDir?: string;
  upstream: { baseUrl: string; apiKey?: string; apiKeyEnv?: string; headers?: Record<string, string>; body?: Record<string, unknown> };
  models: ProviderOffer[];
  /** `dev` is a software stand-in for local testing. `snp` serves the report this machine's AMD CPU signed for the
   * node's encryption key (`report`, raw bytes) and the chip's certificate (`vcek`, DER), which routers verify themselves. */
  tee?: { mode: 'dev'; kind?: number } | { mode: 'snp'; report: string; vcek: string } | { mode: 'tdx'; quote: string };
  /** How often to redeem, and the smallest amount on a channel worth redeeming, in USDC base units. A redemption is a
   * transaction and costs its fee whatever it moves, so small amounts wait (default 50,000 = five cents). A channel
   * that is closing is redeemed whatever it holds. */
  redeem?: { everySecs?: number; minUnits?: number };
  /** Holder pricing: hold `share` basis points of the network token's supply, pay `off` basis points less. */
  holder?: { tiers: HolderTier[] };
  /** Set when the upstream continues a final assistant message (assistant prefill), so routers may resume through this node. */
  resume?: boolean;
  /** List in the price list (pinned on chain) that this node reads payment inside the seal, so a router keeps the channel out
   * of headers from its very first request, whatever the front of this node does to /v1/wire. It changes the list: run
   * provider register again after setting it. */
  paymentInside?: boolean;
  /** Burn on every answer: spend `share` basis points of every USDC this node redeems on buying the network token and
   * burning it. `minUnits` is the smallest buy worth its fee, in USDC base units (default 10,000 = one cent). */
  burn?: { share: number; minUnits?: number };
  /** A webhook to tell when money reaches the wallet: each payout's arrival, as read back from the chain, is posted
   * there as one line (Slack and Discord show it as a message). `urlEnv` names an environment variable holding it. */
  notify?: { url?: string; urlEnv?: string };
  /** How many answers the node streams from its model server at once. When all are taken, a request waits for the next
   * free one, and a wallet that gets the holder price goes ahead of those that do not (the larger discount first). One
   * that waits 30 seconds is turned away as busy before anything is owed, and its router asks the next node. Unset: no
   * limit, every request goes straight to the model server. */
  slots?: number;
  /** Holder lanes: how many of the slots only answer wallets that get the holder price. Requests without one use the
   * rest, so the node keeps room for holders when it is full for everyone else. Needs "slots" and "holder". */
  holderSlots?: number;
};

type Entry = {
  channel: ChannelAccount;
  checkedAt: number;
  owed: bigint;
  best?: Voucher;
  usageHash: Buffer;
  unpaid: (UsageRecord & { owedAfter: bigint })[];
  redeemed: bigint;
};

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

const fail = (res: ServerResponse, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json(res, status, { error: { code, message, ...extra } });

async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error('body too large');
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts);
}

const expand = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~');

/** The address of the wallet a node is listed under. The node only ever needs the address; a missing file gets the
 * two ways on in words, not the file system's error. */
function walletAddress(path: string): PublicKey {
  if (!existsSync(path)) throw new Error(`there is no keypair at ${path}, where this provider.json says your wallet is. The node only needs the wallet's address to find its listing: point "wallet" at your keypair file, or put its address in "authority" and keep the wallet off this machine. The wallet itself signs once, for orrery provider register. No wallet yet? orrery wallet new --out ${path} makes one (any Solana wallet works); it needs a little SOL to pay for the listing.`);
  return loadKeypair(path).publicKey;
}

// Only standard chat fields reach the upstream. A gateway upstream (OpenRouter and the like) reads extra fields such
// as fallback model lists, plugins or provider routing, any of which would let a caller spend the operator's key on
// something the price list does not cover. `n` is dropped for the same reason: it multiplies the output. `user` is
// not passed on either: a caller's end-user id is nobody's business upstream, even when an older router sends one.
const UPSTREAM_FIELDS = [
  'messages', 'temperature', 'top_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty', 'response_format',
  'tools', 'tool_choice', 'parallel_tool_calls', 'logit_bias', 'logprobs', 'top_logprobs',
] as const;

export function upstreamBody(body: Record<string, unknown>, model: string, maxOut: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of UPSTREAM_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return { ...out, model, stream: true, stream_options: { include_usage: true }, max_tokens: maxOut };
}

function secretFromEnv(name: string, what: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${what}: environment variable ${name} is not set`);
  return v;
}

/** Under this much SOL a node key is running low on redeem fees: about 400 payouts at Solana's base fee. */
export const FEE_FLOOR_LAMPORTS = 2_000_000;

/** What one redeem transaction pays when nothing is added on top: Solana's base fee for its one signature. */
export const REDEEM_FEE_LAMPORTS = 5_000;
/** The size of a token account; its rent is what opening the wallet's USDC account costs the first payout. */
export const TOKEN_ACCOUNT_BYTES = 165;

const sol4 = (n: number) => (n / 1e9).toFixed(4);

/** Why a payout failed, when it is the node key's money: the rent of the wallet's USDC account the first payout opens
 * (`openingRent`, null when the account is there), or no SOL for the fee. Empty when the key has enough for both. */
export function payoutFailureNote(o: { lamports: number; openingRent: number | null; nodeKey: string }): string {
  if (o.openingRent && o.lamports < o.openingRent + 10_000) return `; the first payout also opens your wallet’s USDC account, which takes about ${sol4(o.openingRent)} SOL from the node key, and it has ${sol4(o.lamports)} SOL: send a little SOL to ${o.nodeKey}. What routers signed is safe and is redeemed once the key can pay`;
  if (o.lamports < 10_000) return `; the node key has ${(o.lamports / 1e9).toFixed(6)} SOL for fees: send a little SOL to ${o.nodeKey}. What routers signed is safe and is redeemed once the key can pay`;
  return '';
}

/** The fee money line of `provider status`: what the key holds and about how many payouts that is, after the one that
 * opens the wallet's USDC account when it has to. */
export function feesLine(o: { lamports: number; openingRent: number | null; nodeKey: string }): string {
  const payouts = Math.floor(Math.max(0, o.lamports - (o.openingRent ?? 0)) / REDEEM_FEE_LAMPORTS);
  const low = o.lamports < FEE_FLOOR_LAMPORTS + (o.openingRent ?? 0);
  return `${sol4(o.lamports)} SOL on the node key, about ${payouts.toLocaleString('en-US')} payouts${o.openingRent ? '; the first also opens your wallet’s USDC account' : ''}${low ? `; running low, send a little SOL to ${o.nodeKey}` : ''}`;
}

/** The smallest amount worth a redemption's fee when the operator names none: five cents. */
export const REDEEM_MIN_UNITS = 50_000;

/** Whether a channel is redeemed now: it has something waiting, and either enough to be worth the fee, or the user is
 * closing it (after the grace period what was not redeemed goes back to them), or the node has never been paid out on
 * chain (its first payout goes out at once, so a new operator sees money land minutes after the first answer). */
export function worthRedeeming(pending: bigint, minUnits: bigint, closing: boolean, firstPayout = false): boolean {
  return pending > 0n && (pending >= minUnits || closing || firstPayout);
}

/** Whether any channel has a signed total ahead of what is redeemed: the only time a payout round has anything to do. */
export function anythingWaiting(entries: Iterable<{ best?: { cumulative: bigint }; redeemed: bigint }>): boolean {
  for (const e of entries) if (e.best && e.best.cumulative > e.redeemed) return true;
  return false;
}

export class ProviderNode {
  readonly conn: Connection;
  readonly node: Keypair;
  readonly authority: PublicKey;
  readonly pda: PublicKey;
  readonly mint: PublicKey;
  readonly manifest: Manifest;
  readonly manifestBytes: Buffer;
  private vcek: Buffer | null = null;
  readonly enclave: EnclaveKey | null;
  /** The node's own encryption key for requests on the wire, signed with the node key (see seal.ts wireMessage). */
  readonly wire: EnclaveKey;
  readonly attestation: { kind: number; measurement: Buffer; report: Buffer; reportHash: Buffer } | null;
  private readonly apiKey: string | undefined;
  private readonly holders: HolderBook | null;
  /** How many answers stream from the model server at once, from `slots`; null when provider.json sets no limit. */
  private readonly slots: Slots | null;
  private ledger = new Map<string, Entry>();
  private served: { at: number; model: string; channel: string; inputTokens: number; outputTokens: number; cost: bigint; off: number; sealed: boolean }[] = [];
  private answers = 0;
  private readonly reach = new Reach();
  private readonly payoutsOnChain = new Map<string, Landed>();
  private quietTimer: NodeJS.Timeout | null = null;
  private booksTimer: NodeJS.Timeout | null = null;
  private listingRead: { at: number; onChain: { payouts: number; settled: string } | null; fees: { line: string; low: boolean } | null } | null = null;
  private booksDay = utcDay(Date.now());
  private warnedNoCacheReport = false;
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private warnedLowFees = false;
  private consoleKeyValue: string | null = null;
  /** Where each payout's arrival is posted, from `notify`; checked when the node is made, so a bad address stops it at start. */
  readonly notifyTo: string | null;
  /** Where this node keeps its keys and its ledger of what routers signed to it. */
  readonly dir: string;
  log: (line: string) => void = (l) => console.log(l);

  constructor(readonly cfg: ProviderConfig) {
    this.conn = rpcConnection(cfg.rpcUrl);
    this.dir = expand(cfg.dataDir ?? home('provider'));
    this.node = cfg.nodeKeyEnv
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretFromEnv(cfg.nodeKeyEnv, 'node key'))))
      : loadOrCreateKeypair(expand(cfg.nodeKey ?? `${this.dir}/node.json`));
    this.apiKey = cfg.upstream.apiKey ?? (cfg.upstream.apiKeyEnv ? secretFromEnv(cfg.upstream.apiKeyEnv, 'upstream key') : undefined);
    // In a container made by provider compose the wallet file is not there; its address comes in ORRERY_AUTHORITY.
    const given = cfg.authority ?? process.env.ORRERY_AUTHORITY;
    this.authority = given ? new PublicKey(given) : walletAddress(expand(cfg.wallet ?? `${this.dir}/wallet.json`));
    this.pda = pda.provider(this.authority);
    this.mint = new PublicKey(cfg.settleMint);
    this.notifyTo = notifyUrl(cfg.notify);
    const wirePath = `${this.dir}/wire.key`;
    this.wire = existsSync(wirePath) ? enclaveKeyFromSecret(Buffer.from(readFileSync(wirePath, 'utf8').trim(), 'hex')) : newEnclaveKey();
    if (!existsSync(wirePath)) writePrivate(wirePath, this.wire.secret.toString('hex'));
    if (cfg.tee) {
      const keyPath = `${this.dir}/enclave.key`;
      this.enclave = existsSync(keyPath) ? enclaveKeyFromSecret(Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex')) : newEnclaveKey();
      if (!existsSync(keyPath)) writePrivate(keyPath, this.enclave.secret.toString('hex'));
      if (cfg.tee.mode === 'snp') {
        const report = readFileSync(expand(cfg.tee.report));
        const { measurement, debug } = snpClaim(report, this.enclave.publicKey);
        if (debug) throw new Error('this VM was launched with debugging allowed; routers refuse it. Launch it with the debug policy bit off.');
        this.vcek = readFileSync(expand(cfg.tee.vcek));
        this.attestation = { kind: 2, measurement, report, reportHash: createHash('sha256').update(report).digest() };
      } else if (cfg.tee.mode === 'tdx') {
        const quote = readFileSync(expand(cfg.tee.quote));
        const { measurement, debug } = tdxClaim(quote, this.enclave.publicKey);
        if (debug) throw new Error('this VM was launched with debugging allowed; routers refuse it.');
        this.attestation = { kind: 1, measurement, report: quote, reportHash: createHash('sha256').update(quote).digest() };
      } else {
        const kind = cfg.tee.kind ?? 1;
        const measurement = createHash('sha384').update(`orrery-dev-image:${this.node.publicKey.toBase58()}`).digest();
        const report = Buffer.from(JSON.stringify({ dev: true, note: 'software stand-in for a hardware quote; routers must not treat it as verified', kind, measurement: measurement.toString('hex'), enclaveKey: this.enclave.publicKey.toString('hex'), node: this.node.publicKey.toBase58() }));
        this.attestation = { kind, measurement, report, reportHash: createHash('sha256').update(report).digest() };
      }
    } else {
      this.enclave = null;
      this.attestation = null;
    }
    this.manifest = {
      v: 1,
      name: cfg.name,
      authority: this.authority.toBase58(),
      nodeKey: this.node.publicKey.toBase58(),
      region: cfg.region,
      models: cfg.models.map(({ upstreamModel: _u, ...o }) => o),
      tee: this.enclave ? { kind: this.attestation!.kind, enclaveKey: this.enclave.publicKey.toString('hex') } : undefined,
      holder: cfg.holder ? { tiers: checkTiers(cfg.holder.tiers) } : undefined,
      burn: cfg.burn ? { share: cfg.burn.share } : undefined,
      resume: cfg.resume ? true : undefined,
      inside: cfg.paymentInside ? true : undefined,
    };
    this.holders = cfg.holder ? new HolderBook(this.conn) : null;
    // A holder-first model with no holder tiers would be open to nobody: refused at start, with what to set.
    for (const m of cfg.models) {
      if (m.holdersOnly !== undefined && m.holdersOnly !== true) throw new Error(`"holdersOnly" for ${m.id} is true or left out`);
      if (m.holdersOnly && !cfg.holder) throw new Error(`${m.id} is set "holdersOnly", which opens it to wallets that get your holder price: set "holder" tiers too`);
      if (m.kind !== undefined && !(MODEL_KINDS as readonly string[]).includes(m.kind)) throw new Error(`"kind" for ${m.id} is ${MODEL_KINDS.map((k) => `"${k}"`).join(' or ')}, or left out for a chat model`);
    }
    const slots = checkSlots(cfg.slots);
    this.slots = slots ? new Slots(slots, 30_000, checkHolderSlots(cfg.holderSlots, slots, !!cfg.holder)) : null;
    if (!slots) checkHolderSlots(cfg.holderSlots, slots, !!cfg.holder);
    this.manifestBytes = canonical(this.manifest);
    this.load();
  }

  get manifestHash(): Buffer {
    return manifestHash(this.manifestBytes);
  }

  private ledgerPath() {
    return `${this.dir}/ledger.json`;
  }

  private load() {
    if (!existsSync(this.ledgerPath())) return;
    const raw = JSON.parse(readFileSync(this.ledgerPath(), 'utf8')) as Record<string, { owed: string; best?: string; usageHash: string; redeemed: string; channel: string; unpaid: (Omit<UsageRecord, 'cost'> & { cost: string; owedAfter: string })[] }>;
    for (const [k, v] of Object.entries(raw)) {
      this.raw.set(k, Buffer.from(v.channel, 'base64'));
      this.ledger.set(k, {
        channel: decodeChannel(Buffer.from(v.channel, 'base64')),
        checkedAt: 0,
        owed: BigInt(v.owed),
        best: v.best ? decodeVoucher(v.best) : undefined,
        usageHash: Buffer.from(v.usageHash, 'hex'),
        redeemed: BigInt(v.redeemed),
        unpaid: v.unpaid.map((r) => ({ ...r, cost: BigInt(r.cost), owedAfter: BigInt(r.owedAfter) })),
      });
    }
  }

  private raw = new Map<string, Buffer>();

  private save() {
    const out: Record<string, unknown> = {};
    for (const [k, e] of this.ledger) {
      out[k] = {
        owed: e.owed.toString(), best: e.best ? encodeVoucher(e.best) : undefined, usageHash: e.usageHash.toString('hex'), redeemed: e.redeemed.toString(),
        channel: (this.raw.get(k) ?? Buffer.alloc(0)).toString('base64'),
        unpaid: e.unpaid.map((r) => ({ ...r, cost: r.cost.toString(), owedAfter: r.owedAfter.toString() })),
      };
    }
    writePrivate(this.ledgerPath(), JSON.stringify(out));
  }

  private async entry(address: string, force = false): Promise<Entry> {
    const have = this.ledger.get(address);
    if (have && !force && Date.now() - have.checkedAt < 30_000) return have;
    const info = await this.conn.getAccountInfo(new PublicKey(address));
    if (!info) throw Object.assign(new Error('channel not found on chain'), { code: 'unknown_channel', status: 404 });
    if (!info.owner.equals(programId())) throw Object.assign(new Error('not a channel'), { code: 'unknown_channel', status: 400 });
    const ch = decodeChannel(info.data);
    if (!ch.provider.equals(this.pda)) throw Object.assign(new Error('channel is for another provider'), { code: 'wrong_provider', status: 400 });
    if (!ch.mint.equals(this.mint)) throw Object.assign(new Error('channel is in another mint'), { code: 'wrong_mint', status: 400 });
    this.raw.set(address, Buffer.from(info.data));
    const e = have ?? { channel: ch, checkedAt: 0, owed: 0n, usageHash: ZERO_HASH, unpaid: [], redeemed: ch.redeemed };
    e.channel = ch;
    e.checkedAt = Date.now();
    if (ch.redeemed > e.redeemed) e.redeemed = ch.redeemed;
    this.ledger.set(address, e);
    return e;
  }

  private accept(address: string, e: Entry, v: Voucher): void {
    if (!verifyVoucher(e.channel.sessionKey, new PublicKey(address), v)) throw Object.assign(new Error('voucher signature does not match the channel session key'), { code: 'bad_voucher', status: 401 });
    if (!e.best || v.cumulative > e.best.cumulative) {
      e.best = v;
      e.unpaid = e.unpaid.filter((r) => r.owedAfter > v.cumulative);
    }
  }

  /** What this node has earned: signed to it by routers, redeemed on chain, waiting to be redeemed. */
  status() {
    let signed = 0n, redeemed = 0n;
    const channels = [...this.ledger.entries()].map(([channel, e]) => {
      const s = e.best?.cumulative ?? 0n;
      signed += s;
      redeemed += e.redeemed;
      return { channel, deposit: usd(e.channel.deposit), signed: usd(s), redeemed: usd(e.redeemed), waiting: usd(s > e.redeemed ? s - e.redeemed : 0n), unsigned: e.unpaid.length };
    });
    return {
      provider: this.pda.toBase58(), name: this.manifest.name, answers: this.answers,
      // The price list this process serves: what routers read, whatever provider.json says by now.
      manifestHash: this.manifestHash.toString('hex'),
      signed: usd(signed), redeemed: usd(redeemed), waiting: usd(signed > redeemed ? signed - redeemed : 0n),
      channels, recent: this.served.slice().reverse().map((r) => ({ ...r, cost: usd(r.cost) })),
      // What the model server turned away in the last day, by kind: kept in refused.jsonl, so a restart keeps it.
      refused: refusedCounts(readRefused(`${this.dir}/refused.jsonl`), 86_400_000),
      // The last payout to the wallet and the last day's, from payouts.jsonl: null until the first one.
      payouts: withChecked(payoutSummary(readPayouts(`${this.dir}/payouts.jsonl`)), this.payoutsOnChain),
      // How often something outside this computer checked this node in the last hour.
      reach: this.reach.read(),
      // What the next payout round sends and what keeps waiting under redeem.minUnits.
      nextPayout: nextPayout([...this.ledger.values()].map((e) => {
        const paid = e.best ? (e.best.cumulative < e.channel.deposit ? e.best.cumulative : e.channel.deposit) : 0n;
        return { pending: paid > e.redeemed ? paid - e.redeemed : 0n, closing: e.channel.closingAt !== 0n };
      }), BigInt(this.cfg.redeem?.minUnits ?? REDEEM_MIN_UNITS), this.cfg.redeem?.everySecs ?? 60, this.paidOutChecked && !this.paidOut),
      // What the wallet held right after the last payout the node read back from the chain; null until one.
      wallet: readHeld(`${this.dir}/held.json`),
      // Where payout notices go (the webhook's host only: its path is a secret) and what the last one got back.
      notify: this.notifyTo ? { host: new URL(this.notifyTo).host, last: readNotice(`${this.dir}/notice.json`) } : null,
      // How many answers stream at once and who is waiting; holders go first when every slot is taken. Null: no limit.
      slots: this.slots ? this.slots.state : null,
      // The last payout round that failed and why, until one goes through: without it the money only looks stuck.
      payoutFailed: this.payoutFailed,
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/manifest') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-orrery-manifest-sha256': this.manifestHash.toString('hex') });
        return void res.end(this.manifestBytes);
      }
      if (req.method === 'GET' && url.pathname === '/v1/attestation') {
        if (!this.attestation || !this.enclave) return fail(res, 404, 'no_tee', 'this node does not run in an enclave');
        return json(res, 200, { kind: this.attestation.kind, measurement: this.attestation.measurement.toString('hex'), enclaveKey: this.enclave.publicKey.toString('hex'), report: this.attestation.report.toString('base64'), reportHash: this.attestation.reportHash.toString('hex') , ...(this.vcek ? { vcek: this.vcek.toString('base64') } : {}) });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/orrery/status')) {
        if (!isLocal(req)) return fail(res, 404, 'not_found', 'no such route');
        if (!hasConsoleKey(req, url, this.consoleKey())) {
          if (url.pathname !== '/') return fail(res, 404, 'not_found', 'no such route');
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          return void res.end(consoleKeyPage());
        }
        if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return void res.end(providerConsolePage());
        }
        return json(res, 200, this.status());
      }
      // The console's "check against the chain": the payouts it lists, each beside what the chain's record of its
      // transaction says reached the wallet. Asked for by the operator, not polled; one found as kept is not asked again.
      if (req.method === 'GET' && url.pathname === '/orrery/payouts/check') {
        if (!isLocal(req) || !hasConsoleKey(req, url, this.consoleKey())) return fail(res, 404, 'not_found', 'no such route');
        const kept = readPayouts(`${this.dir}/payouts.jsonl`).sort((a, b) => b.at - a.at);
        const rows = await checkPayouts(this.conn, kept.slice(0, 12), this.authority.toBase58(), this.mint.toBase58(), this.payoutsOnChain);
        return json(res, 200, { rows: rows.map(({ p, chain }) => ({ tx: p.tx, state: chain?.state ?? 'unchecked', units: chain?.state === 'landed' ? chain.units.toString() : null })), line: rows.length ? payoutCheckLines(this.cfg.name, rows, kept.length).at(-1) : null });
      }
      if (req.method === 'GET' && url.pathname === '/orrery/earnings') {
        if (!isLocal(req) || !hasConsoleKey(req, url, this.consoleKey())) return fail(res, 404, 'not_found', 'no such route');
        const since = url.searchParams.get('since') ?? '24h';
        const served = readTrips(`${this.dir}/served.jsonl`);
        const { rows, total } = summarize(served, 'model', windowMs(since));
        const out = (r: { key: string; answers: number; inputTokens: number; outputTokens: number; units: bigint }) => ({ key: r.key, answers: r.answers, inputTokens: r.inputTokens, outputTokens: r.outputTokens, usd: usd(r.units) });
        // What has already landed: the listing's own count of payouts to this node's wallet and the total they settled.
        // The console asks every two seconds; the chain is read at most once a minute.
        if (!this.listingRead || Date.now() - this.listingRead.at > 60_000) {
          const listing = await this.conn.getAccountInfo(this.pda).catch(() => undefined);
          // The fee money with it: every payout is a transaction the node key pays for, so payouts stop when it runs out.
          const lamports = await this.conn.getBalance(this.node.publicKey).catch(() => null);
          const openingRent = lamports === null ? null : await this.payoutAccountRent();
          const fees = lamports === null ? null : { line: feesLine({ lamports, openingRent, nodeKey: this.node.publicKey.toBase58() }), low: lamports < FEE_FLOOR_LAMPORTS + (openingRent ?? 0) };
          if (listing !== undefined) this.listingRead = { at: Date.now(), onChain: listing ? ((p) => ({ payouts: Number(p.redeems), settled: usd(p.settled) }))(decodeProvider(listing.data)) : null, fees };
        }
        // The answers at the holder price, and what they came to below the list prices.
        const held = heldSaved(served, windowMs(since));
        // And the same rows by the kind of work each model does in this node's listing: chat, embeddings, rerank.
        return json(res, 200, { since, rows: rows.map(out), kinds: rowsByKind(rows, this.cfg.models).map(out), total: out(total), paidInside: paidInside(served, windowMs(since)), holders: { answers: held.answers, usd: usd(held.units), off: held.offs, line: heldGivenLine(held, total.answers) }, onChain: this.listingRead?.onChain ?? null, fees: this.listingRead?.fees ?? null });
      }
      // The books day by day (UTC), from the node's own files: what each day billed and paid out. No chain call.
      if (req.method === 'GET' && url.pathname === '/orrery/books') {
        if (!isLocal(req) || !hasConsoleKey(req, url, this.consoleKey())) return fail(res, 404, 'not_found', 'no such route');
        const since = url.searchParams.get('since') ?? '7d';
        const b = booksByDay(readTrips(`${this.dir}/served.jsonl`), readPayouts(`${this.dir}/payouts.jsonl`), windowMs(since), Date.now(), readDays(`${this.dir}/days.jsonl`));
        // The console's "Download CSV": the same rows as provider earnings --by day --csv, saved as a file.
        if (url.searchParams.get('format') === 'csv') {
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="orrery-books.csv"', 'cache-control': 'no-store' });
          return void res.end(`${booksByDayCsv(b)}\n`);
        }
        const out = (r: DayBooks) => ({ day: r.day, answers: r.answers, billed: usd(r.billed), payouts: r.payouts, paid: usd(r.paid) });
        // This UTC month so far, whatever the window: the line under the console's books.
        const month = monthSoFar(readTrips(`${this.dir}/served.jsonl`), readPayouts(`${this.dir}/payouts.jsonl`), Date.now(), readDays(`${this.dir}/days.jsonl`));
        return json(res, 200, { since, rows: b.rows.map(out), total: out(b.total), month: { ...out(month), line: monthSentence(month) } });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        // Something outside this computer asked: the operator's own provider check says it is theirs.
        if (!isLocal(req) && !req.headers['x-orrery-own-check'] && this.reach.note()) this.log(firstReachNote(this.reach.read().upMs));
        const upstream = await this.upstreamUp();
        return json(res, 200, { ok: true, upstream: upstream.up ? 'up' : 'down', upstreamMs: upstream.ms, provider: this.pda.toBase58(), models: this.manifest.models.length, channels: this.ledger.size });
      }
      if (req.method === 'GET' && url.pathname === '/v1/seen') {
        // What this node learned about where the request came from. A router that reaches nodes through a proxy asks,
        // and so checks the proxy from this end instead of trusting its own setting.
        return json(res, 200, seenFrom(req), { 'cache-control': 'no-store' });
      }
      if (req.method === 'GET' && url.pathname === '/v1/wire') {
        // The key routers encrypt requests to, signed with the node key that this listing carries on chain.
        // `inside`: this node reads the channel and the voucher from inside the sealed body, so a router need not send
        // them where the node's hosting platform can read them. Signed with the node key (insideSig), so the platform
        // cannot claim it, and a router that has seen it once keeps to it when the platform takes it away.
        const sign = signerOf(this.node);
        return json(res, 200, { key: this.wire.publicKey.toString('hex'), sig: Buffer.from(sign(wireMessage(this.wire.publicKey))).toString('hex'), node: this.node.publicKey.toBase58(), inside: true, insideSig: Buffer.from(sign(insideMessage(this.wire.publicKey))).toString('hex') });
      }
      if (req.method === 'GET' && url.pathname === '/orrery/burns') {
        // What this node pledged and every buy-and-burn it has made, with the transactions a router can check on chain.
        const book = loadBook(this.burnPath());
        return json(res, 200, { provider: this.pda.toBase58(), share: this.cfg.burn?.share ?? 0, spent: book.spent, burned: book.burned, receipts: book.receipts });
      }
      if (req.method === 'GET' && url.pathname === '/orrery/channel') {
        // Where a channel stands on this node: the latest total its router signed (the voucher itself, so a router that
        // lost its own state can check the signature and carry on from there) and what this node is owed.
        const address = url.searchParams.get('address') ?? '';
        try {
          new PublicKey(address);
        } catch {
          return fail(res, 400, 'bad_request', 'address is not a Solana address');
        }
        const e = await this.entry(address);
        return json(res, 200, { channel: address, voucher: e.best ? encodeVoucher(e.best) : null, paid: e.best?.cumulative ?? 0n, owed: e.owed });
      }
      if (req.method === 'POST' && url.pathname === '/orrery/channel') {
        // The same question, sealed, from a router that knows this node reads payment inside the seal. The answer goes
        // back sealed as well: whatever sits in front of this process sees neither the channel nor its voucher.
        let opened: { plaintext: Buffer; key: Buffer };
        try {
          opened = openRequest(this.wire, JSON.parse((await readBody(req)).toString('utf8')) as { epk: string; box: string });
        } catch {
          return fail(res, 409, 'wire_key', 'this question was encrypted to another key; read /v1/wire again');
        }
        const address = String((JSON.parse(opened.plaintext.toString('utf8')) as { address?: unknown }).address ?? '');
        try {
          new PublicKey(address);
        } catch {
          return fail(res, 400, 'bad_request', 'address is not a Solana address');
        }
        const e = await this.entry(address);
        const answer = JSON.stringify({ channel: address, voucher: e.best ? encodeVoucher(e.best) : null, paid: e.best?.cumulative ?? 0n, owed: e.owed }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        return json(res, 200, { box: encrypt(opened.key, padFrame(answer)).toString('base64') });
      }
      if (req.method === 'POST' && url.pathname === '/orrery/voucher') {
        let b = JSON.parse((await readBody(req)).toString('utf8')) as { channel: string; voucher: string; wire?: number };
        // A router that knows this node reads payment inside the seal hands the voucher over sealed as well, and the
        // answer goes back sealed: the running total in it would let the front chain one channel's answers together.
        let replyKey: Buffer | null = null;
        if (b.wire) {
          try {
            const opened = openRequest(this.wire, b as unknown as { epk: string; box: string });
            b = JSON.parse(opened.plaintext.toString('utf8'));
            replyKey = opened.key;
          } catch {
            return fail(res, 409, 'wire_key', 'this voucher was encrypted to another key; read /v1/wire again');
          }
        }
        const e = await this.entry(b.channel);
        this.accept(b.channel, e, decodeVoucher(b.voucher));
        this.save();
        const standing = { paid: e.best?.cumulative ?? 0n, owed: e.owed };
        if (!replyKey) return json(res, 200, standing);
        return json(res, 200, { box: encrypt(replyKey, padFrame(JSON.stringify(standing, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))).toString('base64') });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await this.complete(req, res);
      if (req.method === 'POST' && url.pathname === '/v1/embeddings') return await this.complete(req, res, 'embeddings');
      if (req.method === 'POST' && url.pathname === '/v1/rerank') return await this.complete(req, res, 'rerank');
      if (req.method === 'POST' && url.pathname === '/v1/audio/speech') return await this.complete(req, res, 'speech');
      if (req.method === 'POST' && url.pathname === '/v1/images/generations') return await this.complete(req, res, 'image');
      return fail(res, 404, 'not_found', 'no such route');
    } catch (err) {
      const e = err as Error & { code?: string; status?: number };
      if (!res.headersSent) return fail(res, e.status ?? 500, e.code ?? 'internal', e.message);
      res.end();
    }
  }

  private async complete(req: IncomingMessage, res: ServerResponse, kind: 'chat' | ModelKind = 'chat'): Promise<void> {
    // Which channel pays, and the voucher for what came before: as headers from an older router, or inside the sealed
    // body, where nothing in front of this process (a hosting platform's balancer) can read them.
    let address = String(req.headers['x-orrery-channel'] ?? '');
    let voucherText = req.headers['x-orrery-voucher'] ? String(req.headers['x-orrery-voucher']) : '';
    let body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
    let sealKey: Buffer | null = null;
    let wired = false;
    // This node's own stages, put on the answer (Server-Timing) so whoever asked can see what the node added.
    const arrived = performance.now();
    if (body.wire) {
      // Sealed to this node's own key: the request and the answer are ciphertext to everything between the router and
      // this process.
      let opened: { plaintext: Buffer; key: Buffer };
      try {
        opened = openRequest(this.wire, body as unknown as { epk: string; box: string });
      } catch {
        // Encrypted to a key this node no longer holds (it restarted with a new one): the router fetches /v1/wire again.
        return fail(res, 409, 'wire_key', 'this request was encrypted to another key; read /v1/wire again');
      }
      body = JSON.parse(opened.plaintext.toString('utf8'));
      sealKey = opened.key;
      wired = true;
    } else if (body.sealed) {
      if (!this.enclave) return fail(res, 400, 'no_tee', 'sealed request to a node without an enclave');
      const opened = openRequest(this.enclave, body as unknown as { epk: string; box: string });
      body = JSON.parse(opened.plaintext.toString('utf8'));
      sealKey = opened.key;
    }
    const inside = (sealKey && body.orrery && typeof body.orrery === 'object' ? body.orrery : null) as { channel?: unknown; voucher?: unknown } | null;
    // What a refusal says about this channel's payments (totals, unpaid answers, the deposit) goes back sealed to a router
    // that sent payment inside the seal: totals chain one wallet's requests together, and a deposit names its channel on
    // chain. The code stays readable, so the router knows what to do.
    const payFail = (status: number, code: string, message: string, extra: Record<string, unknown>) =>
      fail(res, status, code, message, inside && sealKey ? { box: encrypt(sealKey, padFrame(JSON.stringify(extra))).toString('base64') } : extra);
    if (inside) {
      if (typeof inside.channel === 'string') address = inside.channel;
      if (typeof inside.voucher === 'string') voucherText = inside.voucher;
      delete body.orrery;
    }
    if (!address) return fail(res, 402, 'channel_required', 'open a channel to this provider and send x-orrery-channel');
    const afterOpen = performance.now();
    const offer = this.cfg.models.find((m) => m.id === body.model);
    if (!offer) return fail(res, 404, 'model_not_offered', `this node does not serve ${String(body.model)}`);
    // A model listed for one kind of request takes only that kind, refused before anything is owed.
    if (offer.kind !== undefined && offer.kind !== kind) return fail(res, 400, 'wrong_kind', `${offer.id} on this node is listed for ${offer.kind}; send it to /v1/${kindPath(offer.kind)}`);
    const e = await this.entry(address);
    const off = this.holders ? await this.holders.off(this.cfg.holder!.tiers, e.channel.payer) : 0;
    // A holder-first model answers only wallets that get the holder price; anyone else is told so before anything is owed.
    if (offer.holdersOnly && !off) {
      const first = Math.min(...this.cfg.holder!.tiers.map((t) => t.share));
      return fail(res, 403, 'holders_only', `${offer.id} on this node is open to $${TICKER} holders only, from ${first / 100}% of the supply`);
    }
    const price = discounted(offer.price, off);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (e.channel.closingAt !== 0n && now > e.channel.closingAt - 120n) return fail(res, 409, 'channel_closing', 'channel is closing; open a new one');
    if (voucherText) {
      const v = decodeVoucher(voucherText);
      if (v.cumulative > e.channel.deposit) await this.entry(address, true);
      this.accept(address, e, v);
    }
    const paid = e.best?.cumulative ?? 0n;
    if (paid < e.owed) return payFail(402, 'payment_required', 'previous requests are not paid for', { owed: e.owed.toString(), paid: paid.toString(), unpaid: e.unpaid.map((r) => ({ ...r, cost: r.cost.toString(), owedAfter: r.owedAfter.toString() })) });
    const askedOut = Number(body.max_completion_tokens ?? body.max_tokens ?? offer.maxOutput);
    const maxOut = kind === 'image' ? imageCount(body) * IMAGE_TOKENS : kind !== 'chat' ? 0 : Math.max(1, Math.min(Number.isFinite(askedOut) ? askedOut : offer.maxOutput, offer.maxOutput));
    const maxCost = costOf(price, estimateInputTokens(body), maxOut);
    if (e.owed + maxCost > e.channel.deposit) {
      await this.entry(address, true);
      if (e.owed + maxCost > e.channel.deposit) return payFail(402, 'channel_exhausted', 'not enough deposit left for this request', { owed: e.owed.toString(), deposit: e.channel.deposit.toString(), need: maxCost.toString() });
    }
    // Every slot answering: wait for the next free one, a holder ahead of those without a holder price. Nothing is
    // owed yet, so a request turned away here costs its router nothing and it asks the next node.
    if (this.slots) {
      const slot = await this.slots.take(off);
      if (!slot) return fail(res, 503, 'busy', `every one of this node's ${this.slots.size} slots was answering for ${this.slots.waitMs / 1000} s; ask another node`);
      if (res.destroyed || res.writableEnded) return slot.give();
      res.once('close', slot.give);
      res.once('finish', slot.give);
      if (slot.passed && slot.waitedMs === 0) this.log(`holder request (−${off / 100}%) went straight into a holder lane while ${slot.passed} waited without a holder price`);
      else if (slot.passed) this.log(`holder request (−${off / 100}%) took the next free slot ahead of ${slot.passed} waiting without a holder price, after ${(slot.waitedMs / 1000).toFixed(1)} s`);
    }

    const settle = (send: (data: string, event?: string) => void, inputTokens: number, outputTokens: number, cachedTokens: number) => {
      const cost = costOf(price, inputTokens, outputTokens, cachedTokens);
      const record: UsageRecord = { requestId: randomUUID(), model: offer.id, inputTokens, outputTokens, cost: cost > maxCost ? maxCost : cost };
      e.owed += record.cost;
      e.usageHash = nextUsageHash(e.usageHash, record);
      e.unpaid.push({ ...record, owedAfter: e.owed });
      this.save();
      send(JSON.stringify({ ...record, cost: record.cost.toString(), owed: e.owed.toString(), usageHash: e.usageHash.toString('hex'), off }), 'orrery');
      res.write(sseFrame('[DONE]'));
      res.end();
      this.answers += 1;
      this.served.push({ at: Date.now(), model: offer.id, channel: address, inputTokens, outputTokens, cost: record.cost, off, sealed: !!sealKey && !wired });
      // At a holder price the log keeps the discount and what it came to: the list prices for the same tokens, less
      // the holder price, so the operator's books say what holder pricing gave away.
      const listed = off ? costOf(offer.price, inputTokens, outputTokens, cachedTokens) : 0n;
      const given = listed > cost ? listed - cost : 0n;
      appendTrip(`${this.dir}/served.jsonl`, { at: Date.now(), model: offer.id, provider: address, providerName: address.slice(0, 8), inputTokens, outputTokens, cost: usd(record.cost), ...(inside ? { inside: true } : {}), ...(off ? { off, saved: usd(given) } : {}) });
      if (this.served.length > 50) this.served.splice(0, this.served.length - 50);
      // The log goes to whoever hosts the node. Paid inside the seal, the channel and its running total were kept from
      // that party on the wire, so they stay off this line too; the console (behind its key) still shows them.
      const paidBy = inside ? '  paid inside the seal' : `  channel ${address.slice(0, 6)}  owed $${usd(e.owed)}`;
      this.log(`served ${offer.id} ${inputTokens}+${outputTokens} tok  $${usd(record.cost)}${paidBy}${off ? `  holder −${off / 100}%` : ''}${wired ? '  wire' : sealKey ? '  sealed' : ''}`);
    };
    const upHeaders = { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(this.cfg.upstream.headers ?? {}) };

    if (kind !== 'chat') {
      // Embeddings, reranking and speech ride the same envelope as a chat stream: one data event with the upstream's
      // answer, then the usage record, so a router pays for them exactly like any other answer, on input tokens only. A
      // rerank goes to the model server's /rerank, in the query-and-documents shape vLLM and Infinity serve; speech to
      // its /audio/speech, the shape Kokoro-FastAPI and other OpenAI-compatible speech servers serve.
      const afterChecks = performance.now();
      const upModel = offer.upstreamModel ?? offer.id;
      const opt = (k: string) => (body[k] !== undefined ? { [k]: body[k] } : {});
      const upBody = kind === 'rerank'
        ? { model: upModel, query: body.query, documents: body.documents, ...opt('top_n'), ...opt('return_documents') }
        : kind === 'speech'
          ? { model: upModel, input: body.input, ...opt('voice'), ...opt('response_format'), ...opt('speed') }
          : kind === 'image'
            ? { model: upModel, prompt: body.prompt, n: imageCount(body), ...opt('size'), ...opt('quality'), response_format: 'b64_json' }
          : { model: upModel, input: body.input, ...(body.encoding_format ? { encoding_format: body.encoding_format } : {}), ...(body.dimensions ? { dimensions: body.dimensions } : {}) };
      const up = await fetchWithTimeout(`${this.cfg.upstream.baseUrl.replace(/\/$/, '')}/${kindPath(kind)}`, {
        method: 'POST',
        timeoutMs: 30_000,
        headers: upHeaders,
        body: JSON.stringify({ ...(this.cfg.upstream.body ?? {}), ...upBody }),
      });
      if (!up.ok) {
        const why = refusal(up.status, (await up.text().catch(() => '')).slice(0, 4_000), offer);
        this.log(why.log);
        appendRefused(`${this.dir}/refused.jsonl`, { at: Date.now(), model: offer.id, kind: why.kind });
        return fail(res, why.status, why.code, why.message);
      }
      // Speech comes back as audio, which a model server does not count in tokens: it travels base64 in the one data
      // event, with its type, and is billed on its text.
      const audio = kind === 'speech' ? Buffer.from(await up.arrayBuffer()) : null;
      const j = audio
        ? { object: 'audio.speech', contentType: up.headers.get('content-type') ?? 'audio/mpeg', bytes: audio.length, audio: audio.toString('base64') } as Record<string, unknown> & { usage?: undefined }
        : (await up.json()) as { usage?: { prompt_tokens?: number; total_tokens?: number } } & Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-orrery-sealed': sealKey ? '1' : '0', 'server-timing': nodeTimingHeader({ open: afterOpen - arrived, check: afterChecks - afterOpen, upstream: performance.now() - afterChecks }) });
      const sendE = (data: string, event?: string) => res.write(sseFrame(sealKey ? encrypt(sealKey, padFrame(data)).toString('base64') : data, event));
      sendE(JSON.stringify({ ...j, model: offer.id }));
      // An image is billed as 1,000 output tokens, for the images that came back (never more than were asked for), and
      // its prompt like speech, one input token per 4 characters.
      const images = kind === 'image' ? Math.min(Array.isArray(j.data) ? j.data.length : 0, imageCount(body)) : 0;
      if (kind === 'image') settle(sendE, speechTokens(body.prompt), images * IMAGE_TOKENS, 0);
      else settle(sendE, audio ? speechTokens(body.input) : j.usage?.prompt_tokens ?? j.usage?.total_tokens ?? estimateInputTokens(body), 0, 0);
      return;
    }

    const afterChecks = performance.now();
    const upstream = await fetchWithTimeout(`${this.cfg.upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      timeoutMs: 30_000,
      headers: upHeaders,
      body: JSON.stringify({ ...(this.cfg.upstream.body ?? {}), ...upstreamBody(body, offer.upstreamModel ?? offer.id, maxOut) }),
    });
    if (!upstream.ok || !upstream.body) {
      // What the server said is read only to tell what kind of refusal it was; it goes no further.
      const why = refusal(upstream.status, upstream.ok ? '' : (await upstream.text().catch(() => '')).slice(0, 4_000), offer);
      this.log(why.log);
      appendRefused(`${this.dir}/refused.jsonl`, { at: Date.now(), model: offer.id, kind: why.kind });
      return fail(res, why.status, why.code, why.message);
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-orrery-sealed': sealKey ? '1' : '0', 'server-timing': nodeTimingHeader({ open: afterOpen - arrived, check: afterChecks - afterOpen, upstream: performance.now() - afterChecks }) });
    // Each sealed frame is padded to whole blocks: its length on the way says nothing about the token in it.
    const send = (data: string, event?: string) => res.write(sseFrame(sealKey ? encrypt(sealKey, padFrame(data)).toString('base64') : data, event));
    type Usage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    let usage: Usage | null = null;
    let chars = 0;
    for await (const ev of readSse(upstream.body)) {
      if (ev.data === '[DONE]') break;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = chunk.usage as Usage;
      for (const c of (chunk.choices as { delta?: { content?: string } }[] | undefined) ?? []) chars += c.delta?.content?.length ?? 0;
      chunk.model = offer.id;
      send(JSON.stringify(chunk));
    }
    const inputTokens = usage?.prompt_tokens ?? estimateInputTokens(body);
    const outputTokens = Math.min(usage?.completion_tokens ?? Math.ceil(chars / 4), maxOut);
    if (price.cachedInput !== undefined && usage && !usage.prompt_tokens_details && !this.warnedNoCacheReport) {
      this.warnedNoCacheReport = true;
      this.log(`${offer.id} lists a cached-input price but the model server reported no cache hits (usage.prompt_tokens_details); vLLM needs --enable-prompt-tokens-details, SGLang --enable-cache-report`);
    }
    settle(send, inputTokens, outputTokens, usage?.prompt_tokens_details?.cached_tokens ?? 0);
  }

  private upstreamCheck: { at: number; up: boolean; ms: number } | null = null;

  /** Whether the model server behind this node answers (its /models list), checked at most every 15 seconds, so a node
   * whose model server is down says so on /health before a router pays for a request that cannot be served. */
  private async upstreamUp(): Promise<{ up: boolean; ms: number }> {
    if (this.upstreamCheck && Date.now() - this.upstreamCheck.at < 15_000) return this.upstreamCheck;
    const t0 = Date.now();
    const headers = { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(this.cfg.upstream.headers ?? {}) };
    const up = await fetchWithTimeout(`${this.cfg.upstream.baseUrl.replace(/\/$/, '')}/models`, { headers, timeoutMs: 3_000 }).then((r) => r.ok).catch(() => false);
    this.upstreamCheck = { at: Date.now(), up, ms: Date.now() - t0 };
    return this.upstreamCheck;
  }

  /** Redeem every channel whose best voucher is ahead of what is on chain, a few channels per transaction. */
  /** Redeems every channel whose signed total is ahead of what is redeemed. Channels are re-read from chain first
   * (a closed one leaves the ledger), packed into transactions that fit Solana's 1232-byte limit, and a batch that
   * fails is retried one channel at a time so one bad channel never holds up the rest. */
  async redeemDue(minUnits = BigInt(this.cfg.redeem?.minUnits ?? REDEEM_MIN_UNITS), o: { firstPayout?: boolean } = {}): Promise<{ channel: string; amount: bigint; tx: string }[]> {
    const due: [string, Entry][] = [];
    for (const [k, e] of [...this.ledger]) {
      if (!e.best || e.best.cumulative <= e.redeemed) continue;
      try {
        await this.entry(k, true);
      } catch (err) {
        if ((err as { code?: string }).code === 'unknown_channel') {
          this.ledger.delete(k);
          this.raw.delete(k);
          this.save();
          this.log(`channel ${k.slice(0, 6)} is closed; dropped from the ledger`);
        }
        continue;
      }
      const pending = (e.best.cumulative < e.channel.deposit ? e.best.cumulative : e.channel.deposit) - e.redeemed;
      const closing = e.channel.closingAt !== 0n;
      if (worthRedeeming(pending, minUnits, closing, o.firstPayout)) due.push([k, e]);
    }
    const ixs = (batch: [string, Entry][]) => batch.flatMap(([k, e]) => redeemInstructions({ caller: this.node.publicKey, providerAuthority: this.authority, channel: new PublicKey(k), mint: this.mint, sessionKey: e.channel.sessionKey, voucher: e.best! }));
    const fits = (batch: [string, Entry][]) => {
      try {
        const tx = new Transaction({ feePayer: this.node.publicKey, recentBlockhash: '11111111111111111111111111111111' }).add(...ixs(batch));
        return tx.serializeMessage().length + 65 <= 1232;
      } catch {
        return false;
      }
    };
    const groups: [string, Entry][][] = [];
    let cur: [string, Entry][] = [];
    for (const d of due) {
      if (cur.length && !fits([...cur, d])) {
        groups.push(cur);
        cur = [];
      }
      cur.push(d);
    }
    if (cur.length) groups.push(cur);
    const done: { channel: string; amount: bigint; tx: string }[] = [];
    for (const g of groups) {
      if (!(await this.redeemBatch(g, ixs, done)) && g.length > 1) for (const one of g) await this.redeemBatch([one], ixs, done);
    }
    if (done.length) await this.feeHeadsUp();
    return done;
  }

  /** The key the node's own pages ask for, kept in console.key in its folder (made on first use, readable only by its
   * owner). The console's address carries it: http://127.0.0.1:<port>/?key=… */
  consoleKey(): string {
    if (this.consoleKeyValue) return this.consoleKeyValue;
    const path = `${this.dir}/console.key`;
    const kept = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    if (/^[0-9a-f]{32}$/.test(kept)) return (this.consoleKeyValue = kept);
    const made = randomBytes(16).toString('hex');
    writePrivate(path, `${made}\n`);
    return (this.consoleKeyValue = made);
  }

  /** The rent of the wallet's USDC account when the first payout still has to open it; null when it is there (or the
   * RPC did not say). */
  async payoutAccountRent(): Promise<number | null> {
    const acct = await this.conn.getAccountInfo(pda.ata(this.authority, this.mint)).catch(() => undefined);
    return acct === null ? await this.conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES).catch(() => null) : null;
  }

  /** Says once, while payouts still go through, that the node key is running low on SOL for their fees. */
  private async feeHeadsUp(): Promise<void> {
    const lamports = await this.conn.getBalance(this.node.publicKey).catch(() => null);
    if (lamports === null) return;
    if (lamports >= FEE_FLOOR_LAMPORTS) {
      this.warnedLowFees = false;
      return;
    }
    if (this.warnedLowFees || lamports < 10_000) return;
    this.warnedLowFees = true;
    this.log(`the node key is running low on SOL for redeem fees: ${(lamports / 1e9).toFixed(6)} SOL, about ${Math.floor(lamports / REDEEM_FEE_LAMPORTS)} more payouts. Send a little SOL to ${this.node.publicKey.toBase58()} before it runs out`);
  }

  /** Reads a payout's transaction back from the chain once it is sent and says in the log what reached the wallet, so
   * the operator sees the money arrive, not only leave. One lookup, tried again a few seconds later when the RPC has
   * no record yet; the console's "on chain" column shows it from then on. */
  private async confirmArrival(p: Payout): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const [r] = await checkPayouts(this.conn, [p], this.authority.toBase58(), this.mint.toBase58(), this.payoutsOnChain);
      if (r?.chain && r.chain.state !== 'missing') {
        if (r.chain.state === 'landed' && r.after !== null) writeHeld(`${this.dir}/held.json`, { at: Date.now(), units: r.after.toString(), tx: p.tx });
        this.log(arrivalNote(p, r.chain, r.after));
        return this.notice(payoutNotice(this.cfg.name, p, r.chain, r.after), 'payout');
      }
      await new Promise((done) => setTimeout(done, 2000 * (i + 1)).unref());
    }
  }

  /** Posts a notice to the `notify` webhook, when there is one; a webhook that fails is said in the log, nothing more.
   * What it answered is kept in notice.json for `provider status` and the console. */
  private async notice(body: unknown, kind: 'payout' | 'books'): Promise<void> {
    if (!this.notifyTo) return;
    const status = await postNotice(this.notifyTo, body);
    writeNotice(`${this.dir}/notice.json`, { at: Date.now(), what: kind, status });
    if (status === null || status < 200 || status > 299) this.log(`the notify webhook ${status === null ? 'could not be reached' : `answered ${status}`}; ${kind === 'payout' ? 'the payout' : 'the day’s books'} is in this log and the console all the same`);
  }

  private async redeemBatch(batch: [string, Entry][], ixs: (b: [string, Entry][]) => TransactionInstruction[], done: { channel: string; amount: bigint; tx: string }[]): Promise<boolean> {
    try {
      const sig = await sendFresh(this.conn, () => new Transaction().add(...ixs(batch)), [this.node]);
      let units = 0n, paidFrom = 0;
      for (const [k, e] of batch) {
        const before = e.redeemed;
        const paid = e.best!.cumulative < e.channel.deposit ? e.best!.cumulative : e.channel.deposit;
        await this.entry(k, true).catch(() => undefined);
        e.redeemed = e.channel.redeemed > paid ? e.channel.redeemed : paid;
        const amount = e.redeemed - before;
        done.push({ channel: k, amount, tx: sig });
        if (amount > 0n) {
          units += amount;
          paidFrom++;
        }
        this.log(`redeemed $${usd(amount)} from channel ${k.slice(0, 6)}  tx ${sig.slice(0, 12)}…`);
      }
      // Kept beside the ledger, so `provider status` can say when money last landed and what the day came to.
      if (units > 0n) {
        const payout = { at: Date.now(), units: units.toString(), channels: paidFrom, tx: sig };
        appendPayout(`${this.dir}/payouts.jsonl`, payout);
        void this.confirmArrival(payout);
      }
      // The listing's count of payouts just changed; the console's next read of it goes to the chain.
      this.listingRead = null;
      this.payoutFailed = null;
      this.save();
      return true;
    } catch (err) {
      // The usual reason a redeem fails for good is a node key with no SOL for the fee, and the chain says it in its own
      // words. Say it plainly, with the address: to an operator it otherwise looks like the payments stopped.
      const lamports = await this.conn.getBalance(this.node.publicKey).catch(() => null);
      // A wallet with no USDC account yet has it opened by the first payout, at the node key's cost.
      const openingRent = lamports === null ? null : await this.payoutAccountRent();
      const broke = lamports === null ? '' : payoutFailureNote({ lamports, openingRent, nodeKey: this.node.publicKey.toBase58() });
      const said = (err as Error).message.split('\n')[0].trim().replace(/[.\s]+$/, '');
      this.log(`redeem failed for ${batch.map(([k]) => k.slice(0, 6)).join(', ')}: ${said}${broke}`);
      // The webhook hears it when payouts start failing, once: rounds run every minute, and the console keeps the latest.
      const first = !this.payoutFailed;
      this.payoutFailed = { at: Date.now(), said: `${said}${broke}` };
      if (first) void this.notice(payoutFailedNotice(this.cfg.name, this.payoutFailed), 'payout');
      return false;
    }
  }

  /** The last payout round that failed since one went through, in the chain's words; null when none has. */
  payoutFailure(): { at: number; said: string } | null {
    return this.payoutFailed;
  }

  /** The chip certificate an SEV-SNP node serves, if it has one. */
  vcekDer(): Buffer | null {
    return this.vcek;
  }

  /** How this node buys the network token and burns it. Unset, a pledge is listed but nothing runs. */
  burnHooks: { swap: Swapper; burn: Burner } | null = null;

  private burnPath() {
    return `${this.dir}/burns.json`;
  }

  /** Buys and burns what the pledge owes on everything redeemed so far, read from the provider's account on chain. */
  async burnDue(): Promise<BurnReceipt | null> {
    if (!this.cfg.burn || !this.burnHooks) return null;
    const info = await this.conn.getAccountInfo(this.pda);
    if (!info) return null;
    const redeemed = decodeProvider(info.data).settled;
    try {
      const r = await burnOnce({ path: this.burnPath(), redeemed, shareBps: this.cfg.burn.share, minUnits: BigInt(this.cfg.burn.minUnits ?? 10_000), ...this.burnHooks });
      if (r) this.log(`burned ${r.burned} token units bought with $${usd(BigInt(r.usdc))}  swap ${r.swapTx.slice(0, 12)}…  burn ${r.burnTx.slice(0, 12)}…`);
      return r;
    } catch (err) {
      this.log(`burn failed: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
  }

  registerInstruction(wallet: PublicKey) {
    return ins.registerProvider(wallet, this.node.publicKey, this.cfg.publicUrl, this.manifestHash);
  }

  updateInstruction(wallet: PublicKey) {
    return ins.updateProvider(wallet, { nodeKey: this.node.publicKey, endpoint: this.cfg.publicUrl, manifestHash: this.manifestHash, active: true });
  }

  attestInstruction(validSecs = 7 * 86_400) {
    if (!this.attestation || !this.enclave) throw new Error('no enclave configured');
    return ins.attest(this.node.publicKey, this.authority, {
      kind: this.attestation.kind,
      measurement: this.attestation.measurement,
      reportHash: this.attestation.reportHash,
      teeKey: this.enclave.publicKey,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + validSecs),
    });
  }

  listen(): Promise<Server> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.listen(this.cfg.listen, this.cfg.host ?? '0.0.0.0', () => resolve(this.server!));
      // What is waiting to be redeemed exists only in the ledger file: say so once when the folder may not stay.
      const warning = folderWarning(this.dir, this.status().waiting);
      if (warning) this.log(warning);
      void this.feeHeadsUp();
      // Whether the next payout is this node's first: the status and console say when money goes out from the start.
      void this.paidOutBefore();
      const every = (this.cfg.redeem?.everySecs ?? 60) * 1000;
      this.timer = setInterval(() => void this.redeemRound().then(() => this.burnDue()).catch(() => undefined), every);
      // Three minutes in, an operator watching this log learns whether anything outside has found the node yet.
      this.quietTimer = setTimeout(() => {
        if (!this.reach.ever) this.log(quietNote(this.reach.read().upMs));
      }, 180_000);
      this.quietTimer.unref?.();
      // Just after midnight UTC, the day that ended in one line: billed, paid out, what the wallet then held.
      this.booksDay = utcDay(Date.now());
      this.booksTimer = setInterval(() => this.booksTick(), 60_000);
      this.booksTimer.unref?.();
    });
  }

  /** Whether this node's listing has been paid out on chain at least once. Read until it has, then remembered. */
  private paidOut = false;
  /** The last payout round that failed, in the chain's words: shown until a round goes through. */
  private payoutFailed: { at: number; said: string } | null = null;
  private paidOutChecked = false;
  async paidOutBefore(): Promise<boolean> {
    if (this.paidOut) return true;
    const info = await this.conn.getAccountInfo(this.pda).catch(() => null);
    // Not listed, or not read: keep the usual floor rather than spend a fee on a guess.
    if (!info) return true;
    this.paidOutChecked = true;
    this.paidOut = decodeProvider(info.data).redeems > 0n;
    return this.paidOut;
  }

  /** One round of the node's own payouts. The first payout of a node never paid out on chain goes out as soon as
   * anything is waiting; after that, payouts wait for redeem.minUnits. */
  async redeemRound(): Promise<{ channel: string; amount: bigint; tx: string }[]> {
    // Nothing waiting, nothing to ask the chain: an idle node makes no RPC calls between answers.
    if (!anythingWaiting(this.ledger.values())) return [];
    const first = !(await this.paidOutBefore());
    const done = await this.redeemDue(undefined, { firstPayout: first });
    if (first && done.length) {
      this.paidOut = true;
      const floor = BigInt(this.cfg.redeem?.minUnits ?? REDEEM_MIN_UNITS);
      this.log(`first payout: $${usd(done.reduce((n, d) => n + d.amount, 0n))} went out at once so you can see it land in your wallet; later payouts wait for $${usd(floor, 2)} each (redeem.minUnits)`);
    }
    return done;
  }

  /** The day's books in one line, from the files the node keeps; null when nothing was served or paid out that day. */
  /** What each model is for, from this node's listing: the day's books say what each kind billed when there were two. */
  private kindOfModel = (model: string): string => {
    const o = this.cfg.models.find((m) => m.id === model);
    return o ? (o.kind ?? (o.price.output === 0 ? 'embeddings' : 'chat')) : 'chat';
  };

  /** What the notify webhook is sent for a closed UTC day: the line, the day's totals, and what each kind of work billed. */
  booksNoticeBody(day: string, kept: DayKept | null): ReturnType<typeof booksNotice> | null {
    const line = this.booksLine(day);
    return line ? booksNotice(this.cfg.name, line, kept, dayKinds(day, readTrips(`${this.dir}/served.jsonl`), this.kindOfModel)) : null;
  }

  booksLine(day: string): string | null {
    return dayBooksLine(day, readTrips(`${this.dir}/served.jsonl`), readPayouts(`${this.dir}/payouts.jsonl`), readHeld(`${this.dir}/held.json`), this.kindOfModel);
  }

  /** Once the UTC date has moved on, say the day that ended. */
  private booksTick(now = Date.now()): void {
    const day = utcDay(now);
    if (day === this.booksDay) return;
    const line = this.booksLine(this.booksDay);
    // The closed day's totals go into days.jsonl, which does not roll over: the books by day keep it after the logs do not.
    const kept = dayToKeep(this.booksDay, readTrips(`${this.dir}/served.jsonl`), readPayouts(`${this.dir}/payouts.jsonl`));
    if (kept) keepDay(`${this.dir}/days.jsonl`, kept);
    if (line) {
      this.log(line);
      void this.notice(this.booksNoticeBody(this.booksDay, kept) ?? booksNotice(this.cfg.name, line, kept), 'books');
    }
    // And when the day that ended was its month's last, the month that ended: its days added up, kept days included.
    if (day.slice(0, 7) !== this.booksDay.slice(0, 7)) {
      const month = monthSoFar(readTrips(`${this.dir}/served.jsonl`), readPayouts(`${this.dir}/payouts.jsonl`), Date.parse(`${this.booksDay}T23:59:59.999Z`), readDays(`${this.dir}/days.jsonl`));
      const said = monthBooksLine(month);
      if (said) {
        this.log(said);
        void this.notice(monthNotice(this.cfg.name, said, month), 'books');
      }
    }
    this.booksDay = day;
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.booksTimer) clearInterval(this.booksTimer);
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
