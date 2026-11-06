// The router: an OpenAI-compatible endpoint on 127.0.0.1. Point any tool at http://127.0.0.1:7171/v1 and it picks a
// provider per request, pays it through a channel, and falls back to the next provider if one fails.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Connection } from '@solana/web3.js';
import { discounted, knownOff, sharePct, tierOff, type HolderBook, type Standing } from '../holder.ts';
import { costOf, estimateInputTokens, usd } from '../pricing.ts';
import { decrypt, sealRequest } from '../seal.ts';
import { fetchWithTimeout, readSse, sseFrame } from '../sse.ts';
import type { UsageRecord } from '../usage.ts';
import { Channels } from './channels.ts';
import { parseModel, rank, Stats, type Candidate, type Route } from './policy.ts';
import { Registry, type ProviderEntry } from './registry.ts';
import { consolePage } from './console.ts';

export type RouterOptions = {
  port: number;
  host?: string;
  route: Route;
  minReputation: number;
  registry: Registry;
  channels: Channels;
  conn: Connection;
  refreshSecs?: number;
  log?: (line: string) => void;
  holders?: HolderBook;
};

export type Trip = {
  at: number;
  model: string;
  route: Route;
  provider: string;
  providerName: string;
  inputTokens: number;
  outputTokens: number;
  cost: string;
  ttftMs: number;
  totalMs: number;
  sealed: boolean;
  fellThrough: number;
  off: number;
};

class Unserved extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'no_provider') {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 8 * 1024 * 1024) throw new Unserved('request too large', 413, 'too_large');
    parts.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

export class Router {
  readonly stats = new Stats();
  readonly trips: Trip[] = [];
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight = new Map<string, bigint>();
  private log: (line: string) => void;

  constructor(private o: RouterOptions) {
    this.log = o.log ?? ((l) => console.log(l));
  }

  async start(): Promise<Server> {
    await this.o.registry.refresh().catch((e) => this.log(`registry refresh failed: ${(e as Error).message}`));
    this.timer = setInterval(() => void this.o.registry.refresh().catch(() => undefined), (this.o.refreshSecs ?? 60) * 1000);
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(this.o.port, this.o.host ?? '127.0.0.1', () => r()));
    return this.server;
  }

  /** This router's wallet's share of the network token, or null when there is no wallet, no token yet, or no RPC. */
  async standing(force = false): Promise<Standing | null> {
    const owner = this.o.channels.owner();
    if (!owner || !this.o.holders) return null;
    try {
      return await this.o.holders.standing(owner, force);
    } catch {
      return null;
    }
  }

  private async offOf(): Promise<(e: ProviderEntry) => number> {
    const s = await this.standing();
    if (!s) return () => 0;
    return (e) => tierOff(e.manifest?.holder?.tiers, s.balance, s.supply);
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: { code: 'origin', message: 'the router only answers this computer' } });
    try {
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return this.models(res);
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) return await this.chat(req, res);
      if (req.method === 'GET' && url.pathname === '/orrery/status') return await this.status(res);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(consolePage());
      }
      return send(res, 404, { error: { code: 'not_found', message: 'no such route' } });
    } catch (err) {
      const e = err as Unserved;
      if (!res.headersSent) return send(res, e.status ?? 500, { error: { code: e.code ?? 'internal', message: e.message } });
      res.end();
    }
  }

  private models(res: ServerResponse) {
    const data = this.o.registry.catalog().map((m) => ({
      id: m.id, object: 'model', owned_by: 'network', providers: m.providers, private_providers: m.private, context_length: m.context,
      pricing: { prompt_per_million: m.cheapest.input / 1e6, completion_per_million: m.cheapest.output / 1e6 },
    }));
    send(res, 200, { object: 'list', data });
  }

  private async status(res: ServerResponse) {
    const providers = [...this.o.registry.entries.values()].map((e) => ({
      address: e.address, name: e.manifest?.name ?? null, endpoint: e.account.endpoint, active: e.account.active, problem: e.problem,
      models: e.manifest?.models.length ?? 0, settled: usd(e.account.settled, 2), redeems: Number(e.account.redeems),
      tee: e.tee ? { verified: e.tee.verified, dev: e.tee.dev, reason: e.tee.reason } : null, observed: this.stats.get(e.address),
    }));
    const channels = this.o.channels.list().map((c) => ({ provider: c.provider, channel: c.channel, deposit: usd(c.deposit), spent: usd(c.cumulative), left: usd(c.deposit - c.cumulative) }));
    const s = await this.standing();
    const holder = s ? { mint: s.mint, balance: s.balance.toString(), supply: s.supply.toString(), share: sharePct(s) } : null;
    send(res, 200, { route: this.o.route, refreshedAt: this.o.registry.refreshedAt, spentToday: usd(this.o.channels.todaySpent()), holder, providers, channels, trips: this.trips.slice(-50).reverse() });
  }

  private async chat(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    if (typeof body.model !== 'string') throw new Unserved('model is required', 400, 'bad_request');
    const header = String(req.headers['x-orrery-route'] ?? '');
    const { model, route } = parseModel(body.model, (['auto', 'price', 'speed', 'reputation', 'privacy'] as Route[]).includes(header as Route) ? (header as Route) : this.o.route);
    const pin = req.headers['x-orrery-provider'] ? String(req.headers['x-orrery-provider']) : null;
    const wantsStream = body.stream === true;
    const estIn = estimateInputTokens(body);
    const estOut = Number(body.max_completion_tokens ?? body.max_tokens ?? 1_024);
    let offers = this.o.registry.offers(model);
    if (pin) offers = offers.filter((o) => o.entry.address.startsWith(pin));
    if (!offers.length) throw new Unserved(`no provider on the network serves ${model}${pin ? ` as ${pin}` : ''}`, 404, 'model_not_found');
    const ranked = rank(offers, route, estIn, estOut, this.stats, this.o.minReputation, await this.offOf());
    if (!ranked.length) throw new Unserved(route === 'privacy' ? `no provider with a verified enclave serves ${model}` : `every provider for ${model} is cooling down`, 503, 'no_provider');
    if (this.o.channels.overBudget(ranked[0].expected)) throw new Unserved('daily spending cap reached (orrery router --daily-cap)', 429, 'budget');

    const tried: string[] = [];
    for (const cand of ranked.slice(0, 3)) {
      try {
        await this.forward(cand, body, wantsStream, res, route, tried.length);
        return;
      } catch (err) {
        tried.push(`${cand.entry.manifest?.name ?? cand.entry.address.slice(0, 6)}: ${(err as Error).message}`);
        this.stats.fail(cand.entry.address);
        if (res.headersSent) {
          res.end();
          return;
        }
      }
    }
    throw new Unserved(`all providers failed: ${tried.join('; ')}`, 502, 'all_failed');
  }

  private async forward(cand: Candidate, body: Record<string, unknown>, wantsStream: boolean, res: ServerResponse, route: Route, fellThrough: number, retried = false): Promise<void> {
    const address = cand.entry.address;
    const maxOut = Math.min(Number(body.max_completion_tokens ?? body.max_tokens ?? cand.offer.maxOutput), cand.offer.maxOutput);
    const maxCost = costOf(cand.offer.price, estimateInputTokens(body), maxOut);
    const ch = await this.o.channels.ensure(address, maxCost);
    const payload = JSON.stringify({ ...body, model: cand.offer.id, stream: true });
    let wire = payload;
    let key: Buffer | null = null;
    if (cand.sealed) {
      if (!cand.entry.tee?.verified) throw new Error('enclave not verified');
      const s = sealRequest(cand.entry.tee.enclaveKey, Buffer.from(payload));
      wire = s.body;
      key = s.key;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-orrery-channel': ch.channel };
    if (ch.voucher) headers['x-orrery-voucher'] = ch.voucher;
    const t0 = Date.now();
    this.inflight.set(address, maxCost);
    const r = await fetchWithTimeout(`${cand.entry.account.endpoint.replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST', headers, body: wire, timeoutMs: 20_000 });
    if (r.status === 402 && !retried) {
      const j = (await r.json()) as { error: { code: string; unpaid?: { requestId: string; model: string; inputTokens: number; outputTokens: number; cost: string }[]; need?: string } };
      if (j.error.code === 'payment_required' && j.error.unpaid?.length === 1) {
        const u = j.error.unpaid[0];
        const allowed = this.inflight.get(address) ?? 0n;
        if (BigInt(u.cost) <= allowed && u.model === cand.offer.id) {
          this.o.channels.settle(address, { ...u, cost: BigInt(u.cost) });
          return this.forward(cand, body, wantsStream, res, route, fellThrough, true);
        }
      }
      if (j.error.code === 'channel_exhausted') {
        await this.o.channels.topUp(address, BigInt(j.error.need ?? '0'));
        return this.forward(cand, body, wantsStream, res, route, fellThrough, true);
      }
      throw new Error(`payment refused: ${j.error.code}`);
    }
    if (!r.ok || !r.body) throw new Error(`provider answered ${r.status}`);

    let ttft = 0;
    let record: (UsageRecord & { owed: string }) | null = null;
    let claimedOff = 0;
    const chunks: Record<string, unknown>[] = [];
    let started = false;
    for await (const ev of readSse(r.body)) {
      let data = ev.data;
      if (data === '[DONE]') break;
      if (key) data = decrypt(key, Buffer.from(data, 'base64')).toString('utf8');
      if (ev.event === 'orrery') {
        const y = JSON.parse(data);
        record = { requestId: y.requestId, model: y.model, inputTokens: y.inputTokens, outputTokens: y.outputTokens, cost: BigInt(y.cost), owed: y.owed };
        claimedOff = knownOff(cand.entry.manifest?.holder?.tiers, y.off);
        continue;
      }
      if (!ttft) ttft = Date.now() - t0;
      if (wantsStream) {
        if (!started) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-orrery-provider': address, 'x-orrery-route': route, ...(key ? { 'x-orrery-sealed': '1' } : {}) });
          started = true;
        }
        res.write(sseFrame(data));
      } else {
        chunks.push(JSON.parse(data));
      }
    }
    if (!record) throw new Error('provider closed the stream without a usage record');
    if (claimedOff < cand.off) {
      this.stats.penalize(address);
      this.log(`provider ${address.slice(0, 6)} lists a ${cand.off / 100}% holder price but applied ${claimedOff / 100}%; paying its number, counting it against its success rate`);
    }
    const ours = costOf(discounted(cand.offer.price, claimedOff), record.inputTokens, record.outputTokens);
    const fair = record.cost <= ours && record.cost <= maxCost ? record.cost : ours < maxCost ? ours : maxCost;
    if (fair !== record.cost) this.log(`provider ${address.slice(0, 6)} billed ${record.cost} but its own prices say ${ours}; paying ${fair}`);
    const voucher = this.o.channels.settle(address, { ...record, cost: fair });
    this.inflight.delete(address);
    void fetchWithTimeout(`${cand.entry.account.endpoint.replace(/\/$/, '')}/orrery/voucher`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: ch.channel, voucher }), timeoutMs: 5_000,
    }).catch(() => undefined);
    this.stats.ok(address, ttft);
    const trip: Trip = {
      at: Date.now(), model: cand.offer.id, route, provider: address, providerName: cand.entry.manifest?.name ?? address.slice(0, 6),
      inputTokens: record.inputTokens, outputTokens: record.outputTokens, cost: usd(fair), ttftMs: ttft, totalMs: Date.now() - t0, sealed: !!key, fellThrough, off: claimedOff,
    };
    this.trips.push(trip);
    if (this.trips.length > 500) this.trips.splice(0, this.trips.length - 500);
    this.log(`${route.padEnd(10)} ${cand.offer.id} → ${trip.providerName}  ${record.inputTokens}+${record.outputTokens} tok  $${trip.cost}  ttft ${ttft}ms${claimedOff ? `  holder −${claimedOff / 100}%` : ''}${key ? '  sealed' : ''}`);

    const orreryHeaders = { 'x-orrery-provider': address, 'x-orrery-route': route, 'x-orrery-cost': trip.cost };
    if (wantsStream) {
      res.write(sseFrame('[DONE]'));
      res.end();
      return;
    }
    send(res, 200, assemble(chunks, cand.offer.id, record.inputTokens, record.outputTokens), orreryHeaders);
  }
}

/** Turn a provider's stream back into the single object a non-streaming OpenAI client expects. */
function assemble(chunks: Record<string, unknown>[], model: string, prompt: number, completion: number) {
  const choices = new Map<number, { index: number; message: { role: string; content: string; tool_calls?: unknown[] }; finish_reason: string | null }>();
  for (const c of chunks) {
    for (const ch of (c.choices as { index?: number; delta?: { role?: string; content?: string; tool_calls?: unknown[] }; finish_reason?: string | null }[] | undefined) ?? []) {
      const i = ch.index ?? 0;
      const cur = choices.get(i) ?? { index: i, message: { role: 'assistant', content: '' }, finish_reason: null };
      if (ch.delta?.content) cur.message.content += ch.delta.content;
      if (ch.delta?.tool_calls) cur.message.tool_calls = [...(cur.message.tool_calls ?? []), ...ch.delta.tool_calls];
      if (ch.finish_reason) cur.finish_reason = ch.finish_reason;
      choices.set(i, cur);
    }
  }
  const first = chunks[0] ?? {};
  return {
    id: (first.id as string) ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: (first.created as number) ?? Math.floor(Date.now() / 1000),
    model,
    choices: [...choices.values()].sort((a, b) => a.index - b.index),
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

