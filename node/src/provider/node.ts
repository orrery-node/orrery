// A provider node: sells inference from any OpenAI-compatible upstream (vLLM, SGLang, Ollama, llama.cpp, or an API
// you hold capacity on) to routers on the network. It never sees a wallet signature per request: it checks the
// router's running-total voucher, serves, meters, and redeems the highest voucher on chain when it chooses.
import { rpcConnection } from '../chain/connect.ts';
import { createHash, randomUUID } from 'node:crypto';
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
import { canonical, manifestHash, type Manifest, type ModelOffer } from '../manifest.ts';
import { checkTiers, discounted, HolderBook, type HolderTier } from '../holder.ts';
import { costOf, estimateInputTokens, usd } from '../pricing.ts';
import { encrypt, enclaveKeyFromSecret, newEnclaveKey, openRequest, wireMessage, type EnclaveKey } from '../seal.ts';
import { readSse, sseFrame, fetchWithTimeout } from '../sse.ts';
import { nodeTimingHeader } from '../router/timing.ts';
import { nextUsageHash, ZERO_HASH, type UsageRecord } from '../usage.ts';
import { isLocal, providerConsolePage } from './console.ts';
import { seenFrom } from '../seen.ts';
import { folderWarning } from './folder.ts';
import { appendTrip, readTrips, summarize, windowMs } from '../spend.ts';

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
  /** Burn on every answer: spend `share` basis points of every USDC this node redeems on buying the network token and
   * burning it. `minUnits` is the smallest buy worth its fee, in USDC base units (default 10,000 = one cent). */
  burn?: { share: number; minUnits?: number };
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

/** The smallest amount worth a redemption's fee when the operator names none: five cents. */
export const REDEEM_MIN_UNITS = 50_000;

/** Whether a channel is redeemed now: it has something waiting, and either enough to be worth the fee or the user is
 * closing it (after the grace period what was not redeemed goes back to them). */
export function worthRedeeming(pending: bigint, minUnits: bigint, closing: boolean): boolean {
  return pending > 0n && (pending >= minUnits || closing);
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
  private ledger = new Map<string, Entry>();
  private served: { at: number; model: string; channel: string; inputTokens: number; outputTokens: number; cost: bigint; off: number; sealed: boolean }[] = [];
  private answers = 0;
  private warnedNoCacheReport = false;
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
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
    this.authority = cfg.authority ? new PublicKey(cfg.authority) : loadKeypair(expand(cfg.wallet ?? `${this.dir}/wallet.json`)).publicKey;
    this.pda = pda.provider(this.authority);
    this.mint = new PublicKey(cfg.settleMint);
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
    };
    this.holders = cfg.holder ? new HolderBook(this.conn) : null;
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
      signed: usd(signed), redeemed: usd(redeemed), waiting: usd(signed > redeemed ? signed - redeemed : 0n),
      channels, recent: this.served.slice().reverse().map((r) => ({ ...r, cost: usd(r.cost) })),
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
        if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return void res.end(providerConsolePage());
        }
        return json(res, 200, this.status());
      }
      if (req.method === 'GET' && url.pathname === '/orrery/earnings') {
        if (!isLocal(req)) return fail(res, 404, 'not_found', 'no such route');
        const since = url.searchParams.get('since') ?? '24h';
        const { rows, total } = summarize(readTrips(`${this.dir}/served.jsonl`), 'model', windowMs(since));
        const out = (r: { key: string; answers: number; inputTokens: number; outputTokens: number; units: bigint }) => ({ key: r.key, answers: r.answers, inputTokens: r.inputTokens, outputTokens: r.outputTokens, usd: usd(r.units) });
        return json(res, 200, { since, rows: rows.map(out), total: out(total) });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
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
        return json(res, 200, { key: this.wire.publicKey.toString('hex'), sig: Buffer.from(signerOf(this.node)(wireMessage(this.wire.publicKey))).toString('hex'), node: this.node.publicKey.toBase58() });
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
      if (req.method === 'POST' && url.pathname === '/orrery/voucher') {
        const b = JSON.parse((await readBody(req)).toString('utf8')) as { channel: string; voucher: string };
        const e = await this.entry(b.channel);
        this.accept(b.channel, e, decodeVoucher(b.voucher));
        this.save();
        return json(res, 200, { paid: e.best?.cumulative ?? 0n, owed: e.owed });
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await this.complete(req, res);
      if (req.method === 'POST' && url.pathname === '/v1/embeddings') return await this.complete(req, res, 'embeddings');
      return fail(res, 404, 'not_found', 'no such route');
    } catch (err) {
      const e = err as Error & { code?: string; status?: number };
      if (!res.headersSent) return fail(res, e.status ?? 500, e.code ?? 'internal', e.message);
      res.end();
    }
  }

  private async complete(req: IncomingMessage, res: ServerResponse, kind: 'chat' | 'embeddings' = 'chat'): Promise<void> {
    const address = String(req.headers['x-orrery-channel'] ?? '');
    if (!address) return fail(res, 402, 'channel_required', 'open a channel to this provider and send x-orrery-channel');
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
    const afterOpen = performance.now();
    const offer = this.cfg.models.find((m) => m.id === body.model);
    if (!offer) return fail(res, 404, 'model_not_offered', `this node does not serve ${String(body.model)}`);
    const e = await this.entry(address);
    const off = this.holders ? await this.holders.off(this.cfg.holder!.tiers, e.channel.payer) : 0;
    const price = discounted(offer.price, off);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (e.channel.closingAt !== 0n && now > e.channel.closingAt - 120n) return fail(res, 409, 'channel_closing', 'channel is closing; open a new one');
    const vh = req.headers['x-orrery-voucher'];
    if (vh) {
      const v = decodeVoucher(String(vh));
      if (v.cumulative > e.channel.deposit) await this.entry(address, true);
      this.accept(address, e, v);
    }
    const paid = e.best?.cumulative ?? 0n;
    if (paid < e.owed) return fail(res, 402, 'payment_required', 'previous requests are not paid for', { owed: e.owed.toString(), paid: paid.toString(), unpaid: e.unpaid.map((r) => ({ ...r, cost: r.cost.toString(), owedAfter: r.owedAfter.toString() })) });
    const askedOut = Number(body.max_completion_tokens ?? body.max_tokens ?? offer.maxOutput);
    const maxOut = kind === 'embeddings' ? 0 : Math.max(1, Math.min(Number.isFinite(askedOut) ? askedOut : offer.maxOutput, offer.maxOutput));
    const maxCost = costOf(price, estimateInputTokens(body), maxOut);
    if (e.owed + maxCost > e.channel.deposit) {
      await this.entry(address, true);
      if (e.owed + maxCost > e.channel.deposit) return fail(res, 402, 'channel_exhausted', 'not enough deposit left for this request', { owed: e.owed.toString(), deposit: e.channel.deposit.toString(), need: maxCost.toString() });
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
      appendTrip(`${this.dir}/served.jsonl`, { at: Date.now(), model: offer.id, provider: address, providerName: address.slice(0, 8), inputTokens, outputTokens, cost: usd(record.cost) });
      if (this.served.length > 50) this.served.splice(0, this.served.length - 50);
      this.log(`served ${offer.id} ${inputTokens}+${outputTokens} tok  $${usd(record.cost)}  channel ${address.slice(0, 6)}  owed $${usd(e.owed)}${off ? `  holder −${off / 100}%` : ''}${wired ? '  wire' : sealKey ? '  sealed' : ''}`);
    };
    const upHeaders = { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...(this.cfg.upstream.headers ?? {}) };

    if (kind === 'embeddings') {
      // Embeddings ride the same envelope as a chat stream: one data event with the upstream's answer, then the usage
      // record, so a router pays for them exactly like any other answer.
      const afterChecks = performance.now();
      const up = await fetchWithTimeout(`${this.cfg.upstream.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        timeoutMs: 30_000,
        headers: upHeaders,
        body: JSON.stringify({ ...(this.cfg.upstream.body ?? {}), model: offer.upstreamModel ?? offer.id, input: body.input, ...(body.encoding_format ? { encoding_format: body.encoding_format } : {}), ...(body.dimensions ? { dimensions: body.dimensions } : {}) }),
      });
      if (!up.ok) return fail(res, 502, 'upstream_error', `upstream answered ${up.status}`);
      const j = (await up.json()) as { usage?: { prompt_tokens?: number } } & Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-orrery-sealed': sealKey ? '1' : '0', 'server-timing': nodeTimingHeader({ open: afterOpen - arrived, check: afterChecks - afterOpen, upstream: performance.now() - afterChecks }) });
      const sendE = (data: string, event?: string) => res.write(sseFrame(sealKey ? encrypt(sealKey, Buffer.from(data)).toString('base64') : data, event));
      sendE(JSON.stringify({ ...j, model: offer.id }));
      settle(sendE, j.usage?.prompt_tokens ?? estimateInputTokens(body), 0, 0);
      return;
    }

    const afterChecks = performance.now();
    const upstream = await fetchWithTimeout(`${this.cfg.upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      timeoutMs: 30_000,
      headers: upHeaders,
      body: JSON.stringify({ ...(this.cfg.upstream.body ?? {}), ...upstreamBody(body, offer.upstreamModel ?? offer.id, maxOut) }),
    });
    if (!upstream.ok || !upstream.body) return fail(res, 502, 'upstream_error', `upstream answered ${upstream.status}`);

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-orrery-sealed': sealKey ? '1' : '0', 'server-timing': nodeTimingHeader({ open: afterOpen - arrived, check: afterChecks - afterOpen, upstream: performance.now() - afterChecks }) });
    const send = (data: string, event?: string) => res.write(sseFrame(sealKey ? encrypt(sealKey, Buffer.from(data)).toString('base64') : data, event));
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
  async redeemDue(minUnits = BigInt(this.cfg.redeem?.minUnits ?? REDEEM_MIN_UNITS)): Promise<{ channel: string; amount: bigint; tx: string }[]> {
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
      if (worthRedeeming(pending, minUnits, closing)) due.push([k, e]);
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
    return done;
  }

  private async redeemBatch(batch: [string, Entry][], ixs: (b: [string, Entry][]) => TransactionInstruction[], done: { channel: string; amount: bigint; tx: string }[]): Promise<boolean> {
    try {
      const sig = await sendFresh(this.conn, () => new Transaction().add(...ixs(batch)), [this.node]);
      for (const [k, e] of batch) {
        const before = e.redeemed;
        const paid = e.best!.cumulative < e.channel.deposit ? e.best!.cumulative : e.channel.deposit;
        await this.entry(k, true).catch(() => undefined);
        e.redeemed = e.channel.redeemed > paid ? e.channel.redeemed : paid;
        const amount = e.redeemed - before;
        done.push({ channel: k, amount, tx: sig });
        this.log(`redeemed $${usd(amount)} from channel ${k.slice(0, 6)}  tx ${sig.slice(0, 12)}…`);
      }
      this.save();
      return true;
    } catch (err) {
      this.log(`redeem failed for ${batch.map(([k]) => k.slice(0, 6)).join(', ')}: ${(err as Error).message.split('\n')[0]}`);
      return false;
    }
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
      const every = (this.cfg.redeem?.everySecs ?? 60) * 1000;
      this.timer = setInterval(() => void this.redeemDue().then(() => this.burnDue()).catch(() => undefined), every);
    });
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
