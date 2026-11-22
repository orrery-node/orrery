// The router: an OpenAI-compatible endpoint on 127.0.0.1. Point any tool at http://127.0.0.1:7171/v1 and it picks a
// provider per request, pays it through a channel, and falls back to the next provider if one fails.
import { fitting, textTokensAtLeast, tooLong } from './context.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Connection } from '@solana/web3.js';
import { discounted, knownOff, sharePct, standingLine, tierOff, type HolderBook, type Standing } from '../holder.ts';
import { TICKER } from '../brand.ts';
import { costOf, estimateInputTokens, usd } from '../pricing.ts';
import { IMAGE_TOKENS, imageCount, kindPath, speechTokens, type ModelKind } from '../manifest.ts';
import { decrypt, padRequest, sealRequest } from '../seal.ts';
import { identityIn, withoutIdentity } from './identity.ts';
import { TEE_KINDS } from '../chain/program.ts';
import { answerEvents, drop, finish, sseFrame } from '../sse.ts';
import { fetchNode, nodeProxy } from '../proxy.ts';
import { askSeen, givenAway, isPublic, ownAddresses, seenAddresses, seenSays } from '../seen.ts';
import { away, nextWait, patienceFrom } from './patience.ts';
import { nodeSaid, roundMs, serverTiming, type Timing } from './timing.ts';
import type { UsageRecord } from '../usage.ts';
import { Channels, PayerProblem } from './channels.ts';
import { apiKeyOf, TaskBook, taskFromKey } from './tasks.ts';
import { AgentBook, agentFromKey } from './agents.ts';
import { ROUTES, applyAlias, burning, openTo, parseCeiling, parseModel, rank, Stats, underCeiling, type Alias, type Candidate, type Ceiling, type Route } from './policy.ts';
import { Registry, type ProviderEntry } from './registry.ts';
import { consolePage } from './console.ts';
import { AnthropicStream, anthropicError, toMessage, toOpenAI, type Chunk } from './anthropic.ts';
import { ResponsesStream, responsesToChat } from './responses.ts';
import { Affinity, prefixes } from './affinity.ts';
import { appendTrip, bills, heldSaved, heldSavedLine, readTrips, skipped, speeds, spendCsv, spentMonthLine, spentThisMonth, summarize, windowMs, type Bills, type Speed, appendUnanswered, readUnanswered, unansweredIn } from '../spend.ts';
import { recordLines, sawText } from './watched.ts';
import { quote, quoteKind, renderQuote } from '../quote.ts';
import { capped, workCap } from './workcap.ts';
import { home } from '../keys.ts';

/** Which API the client spoke, when it is not chat completions: the answer is translated back into that shape. */
type Shape = { kind: 'anthropic' | 'responses' | ModelKind; id: string; withheld?: string[] };

/** The kind of work a request is, when it is not chat: embeddings, rerank or speech, each paid on input tokens only. */
const workOf = (a: Shape | null | undefined): ModelKind | null => (a?.kind === 'embeddings' || a?.kind === 'rerank' || a?.kind === 'speech' || a?.kind === 'image' ? a.kind : null);

/** The output a request of that kind can be billed for: images at 1,000 tokens each, nothing for the other kinds. */
const workOut = (a: Shape | null | undefined, body: Record<string, unknown>): number => (a?.kind === 'image' ? imageCount(body) * IMAGE_TOKENS : 0);

export type RouterOptions = {
  port: number;
  host?: string;
  route: Route;
  minReputation: number;
  registry: Registry;
  channels: Channels;
  conn: Connection;
  refreshSecs?: number;
  /** How long a request whose nodes are all away may stay open while the router waits and goes round again (default
   * 8 seconds; 0 fails at once, as before). */
  patienceMs?: number;
  log?: (line: string) => void;
  holders?: HolderBook;
  aliases?: Alias[];
  /** Never route to a listing above this, after any holder discount. A request can set its own with x-orrery-max-price. */
  maxPrice?: Ceiling;
  /** A dollar budget for every request that does not send its own x-orrery-max-cost. */
  maxCost?: string;
  /** Agent wallets: a spending limit per UTC day for each named agent (x-orrery-agent or the key agent/<name>), in
   * USDC base units. */
  agentCaps?: Map<string, bigint>;
  /** The models each named agent may use (--agent-models); an agent not named may use any. */
  agentModels?: Map<string, Set<string>>;
  /** How often to ask each node whether its model server answers (default 30 seconds). */
  healthSecs?: number;
  /** Private only: every request is sealed to an enclave this router verified, or refused. No route suffix or header
   * can turn it off, so a tool pointed at this router cannot send a prompt in the clear. */
  privateOnly?: boolean;
  /** Where the router keeps its own count of each node (router/observed.json in its home), so a restart goes on from it. */
  observedPath?: string;
};

/** What one client stream has seen so far, kept across providers so a dropped stream can be resumed. */
type StreamState = { started: boolean; stream: AnthropicStream | ResponsesStream | null; text: string; tools: boolean; id?: string; created?: number; routeMs?: number };

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
  /** Where the time went on this machine, stage by stage (see timing.ts). */
  ms?: Timing;
  sealed: boolean;
  /** For a sealed answer: the hardware this router verified before it encrypted the prompt, and the image it booted. */
  enclave?: { kind: string; image: string; verdict: string };
  /** The job an agent named for this request with x-orrery-task. */
  task?: string;
  /** The agent named for this request (x-orrery-agent or the key agent/<name>). */
  agent?: string;
  /** What kind of work the answer was, when it was not chat: embeddings, rerank or speech. */
  kind?: ModelKind;
  /** The request and answer were encrypted to the node's own key, so nothing between the two machines could read them. */
  wire?: boolean;
  /** Identifying fields the client attached and the router did not send on (names only, never the values). */
  withheld?: string[];
  fellThrough: number;
  resumed?: boolean;
  cacheKept?: boolean;
  off: number;
  /** What the node billed for this answer, and what the prices it listed on chain come to for the same tokens. */
  billed?: string;
  listed?: string;
  /** What the holder price took off this answer: the node's listed prices for the same tokens, less the holder price. */
  saved?: string;
};

class Unserved extends Error {
  /** Headers that go out with the refusal, for what a caller should be able to read without parsing the message. */
  constructor(message: string, readonly status = 502, readonly code = 'no_provider', readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

/** A node whose every slot was answering turned the request away (503 busy) before anything was owed. Nothing went
 * wrong at that node: it is full for now, so the router asks the next one and counts nothing against it. */
class NodeFull extends Error {}

/** How long a node that said it was full is asked after the others, on every route. */
export const FULL_MS = 30_000;

/** What a job has spent and has left, as the headers every answer and every budget refusal under it carries. */
const taskHeaders = (t: { budget: bigint; spent: bigint }): Record<string, string> => ({
  'x-orrery-task-spent': usd(t.spent), 'x-orrery-task-left': usd(t.budget > t.spent ? t.budget - t.spent : 0n),
});
/** What an agent has spent today (UTC) and has left of its limit, on every answer and refusal under it. */
const agentHeaders = (a: { cap: bigint; spent: bigint }): Record<string, string> => ({
  'x-orrery-agent-spent': usd(a.spent), 'x-orrery-agent-left': usd(a.cap > a.spent ? a.cap - a.spent : 0n),
});

/** A node's name from its price list, as a header can carry it: printable ASCII as is (up to 80 characters), anything
 * else percent-encoded, so a name with a line break or an accent cannot break the answer. */
export function nameHeader(name: string | undefined): string {
  const n = (name ?? '').slice(0, 80);
  return /^[\x20-\x7e]*$/.test(n) && !n.includes('%') ? n : encodeURIComponent(n);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The host part of a Host header: "localhost:7171" → "localhost", "[::1]:7171" → "[::1]". */
export function hostname(h: string | undefined): string {
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '').toLowerCase();
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
  readonly stats: Stats;
  readonly affinity = new Affinity();
  readonly trips: Trip[] = [];
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private tasks = new TaskBook(1_000, home('router', 'tasks.json'));
  private taskOf = new WeakMap<ServerResponse, string>();
  private agents: AgentBook | null = null;
  private agentOf = new WeakMap<ServerResponse, string>();
  /** What a node last said it sees of this router, asked through the proxy. Null with no proxy, or before asking. */
  private farSide: { node: string; address: string; also: string[]; givenAway: string | null; line: string; checkedAt: number } | null = null;
  private burnTimer: NodeJS.Timeout | null = null;
  private inflight = new Map<string, bigint>();
  /** Vouchers on their way to nodes: each is handed over right after its answer, without holding the answer up. */
  private handing = new Set<Promise<unknown>>();
  /** Requests for an answer that are being served now. */
  private answering = 0;
  /** One request at a time per provider: its gate needs every earlier answer on the channel signed first. */
  private lanes = new Map<string, Promise<void>>();

  private async inLane<T>(address: string, fn: () => Promise<T>): Promise<T> {
    const before = this.lanes.get(address) ?? Promise.resolve();
    let done!: () => void;
    const mine = before.then(() => new Promise<void>((r) => (done = r)));
    this.lanes.set(address, mine);
    await before;
    try {
      return await fn();
    } finally {
      done();
      if (this.lanes.get(address) === mine) this.lanes.delete(address);
    }
  }

  private busy(address: string) {
    return this.lanes.has(address);
  }
  /** Nodes that said every slot was answering, and until when they are asked after the others. */
  private fullUntil = new Map<string, number>();
  private log: (line: string) => void;

  constructor(private o: RouterOptions) {
    this.stats = new Stats(o.observedPath);
    this.agents = new AgentBook(o.agentCaps ?? new Map(), home('router', 'trips.jsonl'));
    this.log = o.log ?? ((l) => console.log(l));
    // Channels asks a node about a channel it lost track of sealed when the node reads payment inside the seal.
    o.channels.wireOf ??= (p) => {
      const e = o.registry.entries.get(p);
      return e?.wire ? { key: e.wire, inside: !!e.wireInside } : o.registry.pinned(p) ? 'missing' : null;
    };
    o.channels.rewire ??= (p) => o.registry.refreshWire(p);
    o.channels.note ??= (l) => this.log(l);
  }

  async start(): Promise<Server> {
    await this.o.registry.refresh().catch((e) => this.log(`registry refresh failed: ${(e as Error).message}`));
    // The same tick reads this wallet's holder standing again, so a request finds it in memory and never waits for it.
    this.timer = setInterval(() => {
      void this.o.registry.refresh().catch(() => undefined);
      void this.standing(true);
      // The proxy is asked about again on the same tick: what it does to a request can change while the router runs.
      if (nodeProxy()) void this.checkProxy().catch(() => undefined);
    }, (this.o.refreshSecs ?? 60) * 1000);
    void this.o.registry.checkHealth().catch(() => undefined);
    void this.o.registry.checkBurnsFromConfig().catch(() => undefined);
    this.burnTimer = setInterval(() => void this.o.registry.checkBurnsFromConfig().catch(() => undefined), 5 * 60_000);
    this.healthTimer = setInterval(() => void this.o.registry.checkHealth().catch(() => undefined), (this.o.healthSecs ?? 30) * 1000);
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(this.o.port, this.o.host ?? '127.0.0.1', () => r()));
    return this.server;
  }

  /** With a proxy set, asks a node what address it sees of this router and keeps the answer for the status page.
   * `givenAway` is this computer's own public address when the node saw it anyway; while it is set nothing is sent.
   * A check that no node answers changes nothing: what was last learned stands. */
  async checkProxy(own: string[] = ownAddresses(), counts: (a: string) => boolean = isPublic): Promise<{ line: string; givenAway: string | null } | null> {
    const proxy = nodeProxy();
    if (!proxy) {
      this.farSide = null;
      return null;
    }
    const said = await askSeen(this.o.registry.usable().filter((e) => e.manifest).map((e) => ({ name: e.manifest!.name, endpoint: e.account.endpoint })));
    if (!said) return { line: seenSays(null, null, proxy, own).detail, givenAway: this.farSide?.givenAway ?? null };
    const away = givenAway(said.seen, own, counts);
    const line = seenSays(said.name, said.seen, proxy, own).detail;
    if (away && this.farSide?.givenAway !== away) this.log(`${said.name} sees ${away}, this computer's own address, through the proxy at ${proxy.label}: nothing is sent until that stops`);
    this.farSide = { node: said.name, address: said.seen.address, also: seenAddresses(said.seen).filter((a) => a !== said.seen.address), givenAway: away, line, checkedAt: Date.now() };
    return { line, givenAway: away };
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

  /** Waits, for at most `maxMs`, until no answer is being served and every voucher on its way to a node has been
   * handed over, and returns how many are still out. A router that is told to stop calls this first: a node left
   * owed for an answer it holds no signature for cannot be picked back up by a router that lost its records. */
  async drain(maxMs = 5_000): Promise<number> {
    const until = Date.now() + maxMs;
    while ((this.answering > 0 || this.handing.size > 0) && Date.now() < until) {
      await Promise.race([Promise.allSettled([...this.handing]), new Promise((r) => setTimeout(r, 50))]);
      if (this.answering > 0) await new Promise((r) => setTimeout(r, 50));
    }
    return this.answering + this.handing.size;
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.burnTimer) clearInterval(this.burnTimer);
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: { code: 'origin', message: 'the router only answers this computer' } });
    // A page on some other site that points its own domain at 127.0.0.1 (DNS rebinding) would read this router with no
    // Origin header; the Host header still names that domain, so a router listening on this computer only answers
    // requests addressed to this computer.
    if (LOOPBACK_HOSTS.has(this.o.host ?? '127.0.0.1') && !LOOPBACK_HOSTS.has(hostname(req.headers.host))) return send(res, 403, { error: { code: 'host', message: 'the router only answers requests addressed to this computer' } });
    if (req.method === 'POST') {
      this.answering += 1;
      res.once('close', () => (this.answering -= 1));
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) return this.models(res);
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) return await this.chat(req, res);
      if (req.method === 'POST' && url.pathname === '/v1/messages') return await this.messages(req, res);
      if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) return await this.responses(req, res);
      if (req.method === 'POST' && (url.pathname === '/v1/embeddings' || url.pathname === '/embeddings')) return await this.embeddings(req, res);
      if (req.method === 'POST' && (url.pathname === '/v1/rerank' || url.pathname === '/rerank')) return await this.rerank(req, res);
      if (req.method === 'POST' && (url.pathname === '/v1/audio/speech' || url.pathname === '/audio/speech')) return await this.speech(req, res);
      if (req.method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/images/generations')) return await this.images(req, res);
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') return send(res, 200, { input_tokens: estimateInputTokens(toOpenAI(await readJson(req))) });
      if (req.method === 'GET' && url.pathname === '/orrery/status') return await this.status(res);
      if (req.method === 'GET' && url.pathname === '/orrery/tasks') return send(res, 200, { tasks: this.tasks.list().map((t) => ({ name: t.name, budget: usd(t.budget), spent: usd(t.spent), left: usd(t.budget > t.spent ? t.budget - t.spent : 0n), answers: t.answers, firstAt: t.firstAt, lastAt: t.lastAt })) });
      if (req.method === 'GET' && url.pathname === '/orrery/quote') {
        // What one request would cost at every provider of a model, from the lists on chain; nothing is sent or paid.
        // A model listed for embeddings, reranking or speech has no output to price, and speech is billed on its text: the
        // text to speak (text, or prompt) is counted the way a node bills it, one input token per 4 characters.
        const model = url.searchParams.get('model') ?? '';
        const kind = quoteKind(this.o.registry.usable(), model);
        const prompt = url.searchParams.get('text') ?? url.searchParams.get('prompt');
        const images = kind === 'image' ? imageCount({ n: url.searchParams.get('images') ?? 1 }) : 0;
        const inTokens = prompt ? (kind === 'speech' || kind === 'image' ? speechTokens(prompt) : estimateInputTokens({ messages: [{ role: 'user', content: prompt }] })) : Number(url.searchParams.get('in') ?? (kind === 'image' ? 50 : 2000));
        const outTokens = kind === 'chat' ? Number(url.searchParams.get('out') ?? 500) : images * IMAGE_TOKENS;
        const about = { kind, ...(kind === 'speech' && prompt ? { chars: prompt.length } : {}), ...(images ? { images } : {}) };
        const cachedShare = Math.max(0, Math.min(1, Number(url.searchParams.get('cached') ?? 0.8)));
        if (!model || !Number.isFinite(inTokens) || !Number.isFinite(outTokens)) return send(res, 400, { error: { message: 'quote needs a model and token counts', type: 'invalid_request_error' } });
        const rows = quote(this.o.registry.usable(), model, inTokens, outTokens, cachedShare);
        // Beside each price, what this router itself saw of the node that lists it.
        const billsBy = new Map(this.billsNow().map((x) => [x.provider, x]));
        const saw = (address: string) => sawText(this.o.registry.watched(address), this.stats.all().get(address), Date.now(), billsBy.get(address));
        return send(res, 200, {
          model, ...(kind === 'chat' ? {} : { kind }), ...(about.chars !== undefined ? { chars: about.chars } : {}), ...(images ? { images } : {}), inTokens, outTokens, cachedShare,
          rows: rows.map((r) => ({ ...r, full: usd(r.full), cached: r.cached === null ? null : usd(r.cached), saw: saw(r.address) || null })),
          text: renderQuote(model, inTokens, outTokens, cachedShare, rows, saw, about),
        });
      }
      if (req.method === 'GET' && url.pathname === '/orrery/spend') {
        const since = url.searchParams.get('since') ?? '24h';
        const byParam = url.searchParams.get('by');
        const by = byParam === 'provider' || byParam === 'task' || byParam === 'day' || byParam === 'agent' || byParam === 'kind' ? byParam : 'model';
        const spendTrips = readTrips(home('router', 'trips.jsonl'));
        const { rows, total } = summarize(spendTrips, by, windowMs(since));
        // The console's "Download CSV": the same rows as orrery spend --csv, saved as a file.
        if (url.searchParams.get('format') === 'csv') {
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="orrery-spend-by-${by}.csv"`, 'cache-control': 'no-store' });
          return void res.end(`${spendCsv(rows, by)}\n`);
        }
        const out = (r: { key: string; answers: number; inputTokens: number; outputTokens: number; units: bigint; cacheKept: number }) => ({ ...r, units: undefined, usd: usd(r.units) });
        const skips = skipped(spendTrips, windowMs(since));
        // This UTC month so far, whatever the window: the line under the console's books by day.
        const m = spentThisMonth(spendTrips);
        // What the holder price took off the answers in the window, from the router's own log.
        const held = heldSaved(spendTrips, windowMs(since));
        return send(res, 200, { since, by, rows: rows.map(out), total: out(total), month: { month: m.month, answers: m.answers, usd: usd(m.units), saved: usd(m.saved), line: spentMonthLine(m) }, held: { answers: held.answers, usd: usd(held.units), off: held.offs, line: heldSavedLine(held) },afterANodeDidNotAnswer: { answers: skips.answers, nodes: skips.nodes }, finishedByAnotherNode: skips.resumed, unanswered: unansweredIn(readUnanswered(home('router', 'unanswered.jsonl')), windowMs(since)), speed: speeds(spendTrips, windowMs(since)), bills: bills(spendTrips, windowMs(since)) });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(consolePage());
      }
      return send(res, 404, { error: { code: 'not_found', message: 'no such route' } });
    } catch (err) {
      const e = err as Unserved;
      if (!res.headersSent && url.pathname.startsWith('/v1/messages')) return send(res, e.status ?? 500, anthropicError(e.status ?? 500, e.message), e.headers ?? {});
      if (!res.headersSent) return send(res, e.status ?? 500, { error: { code: e.code ?? 'internal', message: e.message } }, e.headers ?? {});
      res.end();
    }
  }

  private models(res: ServerResponse) {
    const data = this.o.registry.catalog().map((m) => ({
      id: m.id, object: 'model', owned_by: 'network', providers: m.providers, private_providers: m.private, context_length: m.context,
      // An image model's price per image and a speech model's per million characters, worked out from the listing the way
      // a node bills them, so a client need not know the token rules to see what a picture or a page of speech costs.
      pricing: { prompt_per_million: m.cheapest.input / 1e6, completion_per_million: m.cheapest.output / 1e6, ...(m.cachedFrom !== null ? { cached_prompt_per_million: m.cachedFrom / 1e6 } : {}), ...(m.kind === 'image' ? { per_image: (m.cheapest.output * IMAGE_TOKENS) / 1e12 } : {}), ...(m.kind === 'speech' ? { per_million_characters: m.cheapest.input / 4 / 1e6 } : {}) },
      ...(m.kind ? { kind: m.kind } : {}),
    }));
    send(res, 200, { object: 'list', data });
  }

  /** How fast each node started answering over the last 24 hours, from the router's log; read again at most every
   * 30 seconds, since a console asks for its status every few. */
  private speedKept: { at: number; rows: Speed[]; bills: Bills[] } | null = null;
  private speedNow(): Speed[] {
    if (!this.speedKept || Date.now() - this.speedKept.at > 30_000) {
      const trips = readTrips(home('router', 'trips.jsonl'));
      this.speedKept = { at: Date.now(), rows: speeds(trips, windowMs('24h')), bills: bills(trips, windowMs('24h')) };
    }
    return this.speedKept.rows;
  }

  /** What each node billed against what its listed prices come to, from the same read of the log. */
  private billsNow(): Bills[] {
    this.speedNow();
    return this.speedKept!.bills;
  }

  private async status(res: ServerResponse) {
    const speedBy = new Map(this.speedNow().map((x) => [x.provider, { answers: x.answers, medianTtftMs: x.medianTtftMs }]));
    const billsBy = new Map(this.billsNow().map((x) => [x.provider, { checked: x.checked, over: x.over }]));
    const providers = [...this.o.registry.entries.values()].map((e) => ({
      address: e.address, name: e.manifest?.name ?? null, endpoint: e.account.endpoint, active: e.account.active, problem: e.problem,
      models: e.manifest?.models.length ?? 0, settled: usd(e.account.settled, 2), redeems: Number(e.account.redeems),
      tee: e.tee ? { verified: e.tee.verified, dev: e.tee.dev, reason: e.tee.reason } : null, observed: this.stats.get(e.address),
      modelServer: e.upstream ?? null, healthMs: e.healthMs ?? null, healthAt: e.healthAt ?? null,
      // This router's own record of the node: health checks made, and how many found it up.
      watched: this.o.registry.watched(e.address),
      // How fast it started answering this router, by the router's clock, and the whole record in lines a person reads.
      speed: speedBy.get(e.address) ?? null,
      // Its bills in the last 24 hours against the prices it listed on chain: how many, and how many were above them.
      bills: billsBy.get(e.address) ?? null,
      record: recordLines({ watched: this.o.registry.watched(e.address), observed: this.stats.get(e.address), speed: speedBy.get(e.address), bills: billsBy.get(e.address) }),
      // Whether its last health check was answered (null before the first check), and since when it has not been.
      answering: e.unansweredAt ? false : e.healthAt ? true : null, unansweredSince: e.unansweredAt ?? null,
      // Seconds it is still asked after the others, having said every slot was answering; null when it has not.
      full: ((until) => (until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : null))(this.fullUntil.get(e.address) ?? 0),
      // How a request and its payment go to this node: inside (both sealed to its own key), request (sealed, payment in
      // headers), plain (JSON inside TLS), or withheld (it showed a signed wire key before and shows none now).
      sealing: e.wire ? (e.wireInside ? 'inside' : 'request') : this.o.registry.pinned(e.address) ? 'withheld' : 'plain',
      burn: e.manifest?.burn ? { share: e.manifest.burn.share, verified: !!e.burn, spent: usd(e.burn?.spent ?? 0n), burned: (e.burn?.burned ?? 0n).toString(), receipts: e.burn?.receipts ?? 0, kept: e.burn?.kept ?? null } : null,
    }));
    const channels = this.o.channels.list().map((c) => ({ provider: c.provider, channel: c.channel, deposit: usd(c.deposit), spent: usd(c.cumulative), left: usd(c.deposit - c.cumulative) }));
    const s = await this.standing();
    // Where this wallet stands: its holder price at the nodes that list one, and the nearest step up.
    const priced = [...this.o.registry.entries.values()].filter((e) => e.account.active && !e.problem && e.manifest?.holder?.tiers?.length).map((e) => ({ name: e.manifest?.name ?? e.address.slice(0, 6), tiers: e.manifest!.holder!.tiers }));
    const holder = s ? { mint: s.mint, balance: s.balance.toString(), supply: s.supply.toString(), share: sharePct(s), line: standingLine(s, priced, TICKER) } : null;
    send(res, 200, { route: this.o.route, privateOnly: !!this.o.privateOnly, proxy: nodeProxy()?.label ?? null, proxySeen: nodeProxy() && this.farSide ? { node: this.farSide.node, address: this.farSide.address, also: this.farSide.also, givenAway: this.farSide.givenAway, checkedAt: this.farSide.checkedAt } : null, refreshedAt: this.o.registry.refreshedAt, spentToday: usd(this.o.channels.todaySpent()), holder, providers, channels, trips: this.trips.slice(-50).reverse(), agents: this.agents!.list().map((a) => ({ name: a.name, cap: a.cap === null ? null : usd(a.cap), spent: usd(a.spent), left: a.cap === null ? null : usd(a.cap > a.spent ? a.cap - a.spent : 0n), ...(this.o.agentModels?.get(a.name) ? { models: [...this.o.agentModels.get(a.name)!] } : {}) })) });
  }

  private async chat(req: IncomingMessage, res: ServerResponse) {
    return this.serve(await readJson(req), req, res, null);
  }

  /** The Anthropic Messages API: translated to a chat request, served the same way, answered in Anthropic's shape. */
  private async messages(req: IncomingMessage, res: ServerResponse) {
    const a = await readJson(req);
    if (typeof a.model !== 'string') throw new Unserved('model is required', 400, 'bad_request');
    if (!Array.isArray(a.messages) || !a.messages.length) throw new Unserved('messages is required', 400, 'bad_request');
    return this.serve(toOpenAI(a), req, res, { kind: 'anthropic', id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, withheld: identityIn(a) });
  }

  /** The OpenAI Responses API: translated to a chat request, served the same way, answered as a response object. */
  /** OpenAI embeddings: routed and paid like any answer, priced on input tokens only. */
  private async embeddings(req: IncomingMessage, res: ServerResponse) {
    const a = await readJson(req);
    if (typeof a.model !== 'string' && !Array.isArray(a.models)) throw new Unserved('model is required', 400, 'bad_request');
    if (a.input === undefined || (Array.isArray(a.input) && !a.input.length)) throw new Unserved('input is required', 400, 'bad_request');
    return this.serve({ ...a, stream: false }, req, res, { kind: 'embeddings', id: '', withheld: identityIn(a) });
  }

  /** Reranking (a query and the documents to order by it, the shape vLLM and Infinity serve): routed and paid like any
   * answer, priced on input tokens only, as embeddings are. */
  private async rerank(req: IncomingMessage, res: ServerResponse) {
    const a = await readJson(req);
    if (typeof a.model !== 'string' && !Array.isArray(a.models)) throw new Unserved('model is required', 400, 'bad_request');
    if (typeof a.query !== 'string' || !a.query) throw new Unserved('query is required', 400, 'bad_request');
    if (!Array.isArray(a.documents) || !a.documents.length) throw new Unserved('documents is required: a list of the texts to rerank', 400, 'bad_request');
    return this.serve({ ...a, stream: false }, req, res, { kind: 'rerank', id: '', withheld: identityIn(a) });
  }

  /** Text to speech (the OpenAI shape: the text as input, a voice, a format): routed and paid like any answer, on its
   * text, one input token per 4 characters. The answer is the audio itself. */
  private async speech(req: IncomingMessage, res: ServerResponse) {
    const a = await readJson(req);
    if (typeof a.model !== 'string' && !Array.isArray(a.models)) throw new Unserved('model is required', 400, 'bad_request');
    if (typeof a.input !== 'string' || !a.input) throw new Unserved('input is required: the text to speak', 400, 'bad_request');
    return this.serve({ ...a, stream: false }, req, res, { kind: 'speech', id: '', withheld: identityIn(a) });
  }

  /** Image generation (the OpenAI shape: a prompt, n, a size): routed and paid like any answer, each image billed as
   * 1,000 output tokens and the prompt on input. The images come back base64 (b64_json), inside the seal like any answer. */
  private async images(req: IncomingMessage, res: ServerResponse) {
    const a = await readJson(req);
    if (typeof a.model !== 'string' && !Array.isArray(a.models)) throw new Unserved('model is required', 400, 'bad_request');
    if (typeof a.prompt !== 'string' || !a.prompt) throw new Unserved('prompt is required: what to draw', 400, 'bad_request');
    if (a.n !== undefined && imageCount({ n: a.n }) !== Number(a.n)) throw new Unserved('n is the number of images, 1 to 10', 400, 'bad_request');
    return this.serve({ ...a, stream: false }, req, res, { kind: 'image', id: '', withheld: identityIn(a) });
  }

  private async responses(req: IncomingMessage, res: ServerResponse) {
    const a = await readJson(req);
    if (typeof a.model !== 'string') throw new Unserved('model is required', 400, 'bad_request');
    if (a.input === undefined || (Array.isArray(a.input) && !a.input.length)) throw new Unserved('input is required', 400, 'bad_request');
    return this.serve(responsesToChat(a), req, res, { kind: 'responses', id: `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, withheld: identityIn(a) });
  }

  /** A request may name fallbacks, as "a|b" or an OpenRouter-style models array: when no provider of one model can
   * serve it (none listed, over the price ceiling, all cooling down or all failed before answering), the next is tried. */
  private async serve(body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse, anth: Shape | null) {
    const list = Array.isArray(body.models) && body.models.length && body.models.every((m) => typeof m === 'string') ? (body.models as string[]) : typeof body.model === 'string' ? body.model.split('|').map((m) => m.trim()).filter(Boolean) : [];
    if (!list.length) throw new Unserved('model is required', 400, 'bad_request');
    const rest: Record<string, unknown> = { ...body };
    delete rest.models;
    let last: Unserved | null = null;
    // Nodes asked for this request that did not answer, across its models: counted once the request has no answer at all.
    let asked = 0;
    for (const m of list.slice(0, 4)) {
      try {
        return await this.serveOne({ ...rest, model: m }, req, res, anth);
      } catch (e) {
        const u = e as Unserved & { asked?: number };
        asked += u.asked ?? 0;
        if (res.headersSent || !['model_not_found', 'over_price_ceiling', 'over_budget', 'no_provider', 'all_failed', 'context_length_exceeded'].includes(u.code)) throw e;
        last = u;
        if (list.length > 1) this.log(`${m}: ${u.message}; trying the next model`);
      }
    }
    // Kept so the router's spend can say what went unanswered, and that nothing was signed for it. A request a fallback
    // model answered is not one of them.
    if (asked > 0) appendUnanswered(home('router', 'unanswered.jsonl'), { at: Date.now(), model: list[0], asked });
    throw last ?? new Unserved('model is required', 400, 'bad_request');
  }

  private async serveOne(body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse, anth: Shape | null) {
    const began = performance.now();
    if (typeof body.model !== 'string') throw new Unserved('model is required', 400, 'bad_request');
    let patienceMs: number;
    try {
      patienceMs = patienceFrom(req.headers['x-orrery-patience'] === undefined ? undefined : String(req.headers['x-orrery-patience']), this.o.patienceMs ?? 8_000);
    } catch (e) {
      throw new Unserved((e as Error).message, 400, 'bad_request');
    }
    // A proxy that is set and gives this computer's address to a node hides nothing: the request stays here.
    if (this.farSide?.givenAway && nodeProxy()) throw new Unserved(`${this.farSide.node} sees ${this.farSide.givenAway}, this computer's own address, through the proxy; nothing is sent until the proxy stops giving it away`, 503, 'proxy_gives_address_away');
    const header = String(req.headers['x-orrery-route'] ?? '');
    const asked = parseModel(applyAlias(body.model, this.o.aliases), (ROUTES as readonly string[]).includes(header) ? (header as Route) : this.o.route);
    const model = asked.model, route: Route = this.o.privateOnly ? 'privacy' : asked.route;
    const pin = req.headers['x-orrery-provider'] ? String(req.headers['x-orrery-provider']) : null;
    const wantsStream = body.stream === true;
    const estIn = estimateInputTokens(body);
    const estOut = workOf(anth) ? workOut(anth, body) : Number(body.max_completion_tokens ?? body.max_tokens ?? 1_024);
    let offers = this.o.registry.offers(model);
    if (pin) offers = offers.filter((o) => o.entry.address.startsWith(pin));
    // A listing that says what its model is for gets only that kind of request; one that does not takes any, as before.
    const wantKind = workOf(anth) ?? 'chat';
    const otherKind = offers.find((o) => o.offer.kind !== undefined && o.offer.kind !== wantKind)?.offer.kind;
    offers = offers.filter((o) => o.offer.kind === undefined || o.offer.kind === wantKind);
    if (!offers.length && otherKind) throw new Unserved(`${model} is listed for ${otherKind}; send it to /v1/${kindPath(otherKind)}`, 400, 'wrong_kind');
    if (!offers.length) throw new Unserved(`no provider on the network serves ${model}${pin ? ` as ${pin}` : ''}`, 404, 'model_not_found');
    const answering = offers.filter((o) => o.entry.upstream !== 'down');
    if (!answering.length) throw new Unserved(`every provider of ${model} reports its model server down right now`, 503, 'no_provider');
    // A prompt clearly longer than the context a node lists goes to a node that lists enough: the first would refuse
    // it, and that would count against it. Nothing changes when no node lists enough.
    // Longer than every context on offer: no node is asked, and the client gets the error it shortens its conversation on.
    const over = tooLong(body, answering);
    if (over) throw new Unserved(anth?.kind === 'anthropic' ? over.anthropic : over.openai, 400, 'context_length_exceeded');
    const roomy = fitting(body, answering);
    if (roomy.length < answering.length) this.log(`${model}: a prompt of at least ${textTokensAtLeast(body).toLocaleString('en-US')} tokens passes over ${answering.length - roomy.length} node${answering.length - roomy.length === 1 ? '' : 's'} that list${answering.length - roomy.length === 1 ? 's' : ''} less context`);
    offers = roomy;
    let ceiling: Ceiling | undefined;
    try {
      ceiling = req.headers['x-orrery-max-price'] ? parseCeiling(String(req.headers['x-orrery-max-price'])) : this.o.maxPrice;
    } catch (e) {
      throw new Unserved((e as Error).message, 400, 'bad_request');
    }
    const offOf = await this.offOf();
    // Holder-first listings are asked only when this wallet gets that node's holder price: anyone else would be refused.
    const forUs = openTo(offers, offOf);
    if (!forUs.open.length) throw new Unserved(`${model} is open to $${TICKER} holders only at ${forUs.closed === 1 ? 'the node that serves it' : `all ${forUs.closed} nodes that serve it`}, and this router's wallet does not get a holder price there yet`, 403, 'holders_only');
    offers = forUs.open;
    if (ceiling) {
      const within = offers.filter((o) => underCeiling(discounted(o.offer.price, offOf(o.entry)), ceiling));
      if (!within.length) {
        const low = offers.map((o) => discounted(o.offer.price, offOf(o.entry))).sort((a, b) => a.input + a.output - (b.input + b.output))[0];
        const d = (u: number) => `$${(u / 1e6).toFixed(u % 10_000 ? 4 : 2)}`;
        throw new Unserved(`no provider serves ${model} under your price ceiling of ${d(ceiling.input)}/${d(ceiling.output)} per million; the lowest listing is ${d(low.input)}/${d(low.output)}`, 404, 'over_price_ceiling');
      }
      offers = within;
    }
    // A dollar budget for this one request. Each provider caps what it bills at the cost of the full prompt plus the
    // most output it may write, and the router never signs past that cap either, so a listing whose cap fits the
    // budget cannot cost more.
    // A task budget: every request that names the same task draws from one budget, so an agent's whole job has a
    // ceiling. What is left of it becomes this request's budget, which is how the total can never be passed.
    let taskLeft: bigint | null = null;
    let taskNow: { budget: bigint; spent: bigint } | null = null;
    // The job is named by header, or, for tools that can only set a key, in the key itself (orrery/<task>/<budget>).
    const keyed = req.headers['x-orrery-task'] ? null : taskFromKey(apiKeyOf(req.headers));
    const taskName = req.headers['x-orrery-task'] ? String(req.headers['x-orrery-task']) : keyed?.name ?? null;
    if (taskName) {
      const tb = req.headers['x-orrery-task-budget'] ?? keyed?.budget ?? undefined;
      const tDollars = tb === undefined ? null : Number(String(tb).replace(/^\$/, ''));
      if (tDollars !== null && (!Number.isFinite(tDollars) || tDollars <= 0)) throw new Unserved('x-orrery-task-budget must be a dollar amount such as 0.05', 400, 'bad_request');
      try {
        const opened = this.tasks.open(taskName, tDollars === null ? null : BigInt(Math.floor(tDollars * 1e6)));
        taskLeft = opened.left;
        taskNow = opened.task;
      } catch (e) {
        throw new Unserved((e as Error).message, 400, 'bad_request');
      }
      if (taskLeft <= 0n) throw new Unserved(`task ${taskName} has spent its budget; nothing more is sent or paid under it`, 402, 'task_budget_spent', taskHeaders(taskNow!));
      this.taskOf.set(res, taskName);
    }
    // An agent wallet: the agent named by header (or by the key agent/<name>) may have a limit for today (UTC). What is
    // left of it bounds this request as well, so the day's limit can never be passed either.
    const agentName = req.headers['x-orrery-agent'] ? String(req.headers['x-orrery-agent']) : agentFromKey(apiKeyOf(req.headers));
    let agentLeft: bigint | null = null;
    let agentDay: { cap: bigint; spent: bigint } | null = null;
    if (agentName) {
      if (!AgentBook.valid(agentName)) throw new Unserved('x-orrery-agent is a name of letters, digits and ._:- up to 64 characters', 400, 'bad_request');
      // An agent given a list of models uses those only: refused before any node is asked or anything is owed.
      const menu = this.o.agentModels?.get(agentName);
      if (menu && !menu.has(model)) throw new Unserved(`agent ${agentName} may use ${[...menu].join(', ')}; ${model} is not one of them`, 403, 'agent_model');
      const a = this.agents!.left(agentName);
      if (a) {
        agentLeft = a.left;
        agentDay = a;
        if (a.left <= 0n) throw new Unserved(`agent ${agentName} has spent its $${usd(a.cap)} for today (UTC); it can spend again from 00:00 UTC`, 402, 'agent_cap', agentHeaders(a));
      }
      this.agentOf.set(res, agentName);
    }
    const limitLeft = taskLeft === null ? agentLeft : agentLeft === null ? taskLeft : taskLeft < agentLeft ? taskLeft : agentLeft;
    const budgetHeader = req.headers['x-orrery-max-cost'] ?? this.o.maxCost;
    if (budgetHeader !== undefined || limitLeft !== null) {
      const dollars = budgetHeader === undefined ? Infinity : Number(String(budgetHeader).replace(/^\$/, ''));
      if (budgetHeader !== undefined && (!Number.isFinite(dollars) || dollars <= 0)) throw new Unserved('x-orrery-max-cost must be a dollar amount such as 0.001', 400, 'bad_request');
      const own = budgetHeader === undefined ? null : BigInt(Math.floor(dollars * 1e6));
      const budget = own === null ? limitLeft! : limitLeft !== null && limitLeft < own ? limitLeft : own;
      const worst = (o: (typeof offers)[number]) => costOf(discounted(o.offer.price, offOf(o.entry)), estIn, workOf(anth) ? workOut(anth, body) : Math.min(Number(body.max_completion_tokens ?? body.max_tokens ?? o.offer.maxOutput), o.offer.maxOutput));
      const fits = offers.filter((o) => worst(o) <= budget);
      if (!fits.length) {
        const low = offers.map(worst).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
        throw new Unserved(`no provider can answer ${model} within $${usd(budget)} for this request; the cheapest could cost up to $${usd(low)} (lower max_tokens or raise the budget)${taskLeft !== null && taskLeft === budget ? `; task ${taskName} has $${usd(taskLeft)} left` : agentLeft !== null && agentLeft === budget ? `; agent ${agentName} has $${usd(agentLeft)} left today (UTC)` : ''}`,
          // A budget the caller set for this one request that nothing fits is a search with no result (404). A job or an
          // agent whose remaining money cannot cover one more request is out of money (402), which no client mistakes for
          // a missing model.
          limitLeft !== null && limitLeft === budget ? 402 : 404, 'over_budget', { ...(taskNow ? taskHeaders(taskNow) : {}), ...(agentDay ? agentHeaders(agentDay) : {}) });
      }
      offers = fits;
    }
    const keys = prefixes(model, body.messages);
    const sticky = this.affinity.find(keys);
    const ranked = rank(offers, route, estIn, estOut, this.stats, this.o.minReputation, offOf, (e) => (sticky && e.address === sticky.address ? sticky.tokens : 0));
    if (!ranked.length) throw new Unserved(route === 'privacy' ? `no provider with a verified enclave serves ${model}${whyNotPrivate(offers)}` : route === 'burn' ? `no provider of ${model} has a burn pledge this router has verified on chain` : `every provider for ${model} is cooling down`, 503, 'no_provider');
    if (this.o.channels.overBudget(ranked[0].expected)) throw new Unserved('daily spending cap reached (orrery router --daily-cap)', 429, 'budget');

    const tried: string[] = [];
    const state: StreamState = { started: false, stream: null, text: '', tools: false, routeMs: performance.now() - began };
    const top = ranked.slice(0, 3);
    // On the auto and speed routes a provider already answering another request hands this one to the next of the top
    // three that is free; the price and reputation routes wait their turn.
    const free = route === 'auto' || route === 'speed' ? [...top.filter((c) => !this.busy(c.entry.address)), ...top.filter((c) => this.busy(c.entry.address))] : top;
    // A node that said in the last 30 s that every slot was answering goes after the others on every route: asked
    // first, it would hold the request in its queue until it turned it away again.
    const full = (c: (typeof top)[number]) => (this.fullUntil.get(c.entry.address) ?? 0) > Date.now();
    const cands = [...free.filter((c) => !full(c)), ...free.filter(full)];
    let prefill: string | null = null;
    const counted = new Set<string>();
    // A channel that could not be opened because of this router's own wallet: nothing a node did.
    let payer: PayerProblem | null = null;
    for (let round = 0; ; round++) {
      let allAway = true;
      for (let i = 0; i < cands.length; i++) {
        const cand = cands[i];
        try {
          const b = prefill === null ? body : { ...body, messages: [...((body.messages as unknown[]) ?? []), { role: 'assistant', content: prefill }] };
          await this.inLane(cand.entry.address, () => this.forward(cand, b, wantsStream, res, route, tried.length, false, anth, state, prefill !== null));
          if (prefill === null) this.affinity.remember(keys, cand.entry.address);
          return;
        } catch (err) {
          // The wallet could not pay for a channel to this node. Another node may already have one open, so the next is
          // tried; this one is not counted against, and waiting would change nothing.
          if (err instanceof PayerProblem) {
            payer = err;
            allAway = false;
            continue;
          }
          if (round === 0) tried.push(`${cand.entry.manifest?.name ?? cand.entry.address.slice(0, 6)}: ${(err as Error).message}`);
          // A full node is there and honest about it: the next node is asked, and this one is not counted against.
          if (err instanceof NodeFull) {
            allAway = false;
            this.fullUntil.set(cand.entry.address, Date.now() + FULL_MS);
            this.log(`${cand.entry.manifest?.name ?? cand.entry.address.slice(0, 6)} said every slot was answering; asking the next node, nothing counted against it, and it goes after the others for ${FULL_MS / 1000} s`);
            continue;
          }
          if (!away(err)) allAway = false;
          // One request counts once against a node, however many rounds it took.
          if (!counted.has(cand.entry.address)) {
            this.stats.fail(cand.entry.address);
            this.o.registry.noteRequest(cand.entry.address, false);
          }
          counted.add(cand.entry.address);
          if (res.headersSent) {
            // The client already has part of the answer. Hand that text to the next provider that says it can continue it,
            // and keep writing into the same stream; a stream that carried a tool call ends here.
            const next = state.text && !state.tools ? cands.findIndex((c, j) => j > i && c.entry.manifest?.resume === true) : -1;
            if (next > i) {
              this.log(`stream from ${cand.entry.manifest?.name ?? cand.entry.address.slice(0, 6)} dropped after ${state.text.length} chars; resuming with ${cands[next].entry.manifest?.name ?? cands[next].entry.address.slice(0, 6)}`);
              prefill = state.text;
              i = next - 1;
              continue;
            }
            const dropped = 'the provider dropped the stream and no other provider could resume it';
            if (anth?.kind === 'anthropic') res.write(`event: error\ndata: ${JSON.stringify(anthropicError(502, dropped))}\n\n`);
            if (anth?.kind === 'responses') res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code: 'provider_dropped', message: dropped })}\n\n`);
            res.end();
            return;
          }
        }
      }
      // Nothing has reached the client. When every node was away (not there, or something in front of it answered for
      // it), the router waits a moment and goes round once more: a node that restarts is back in seconds.
      const wait = allAway && !res.headersSent ? nextWait(round, performance.now() - began, patienceMs) : null;
      if (wait === null) break;
      this.log(`no node for ${model} could be reached; asking again in ${wait / 1000} s`);
      await new Promise((r) => setTimeout(r, wait));
    }
    // The client's SDK reads Retry-After before it tries again; by now this request has already waited its own share.
    // Nothing a node did: the router's own wallet could not pay. Said as that, with what to do.
    if (payer && !tried.length) throw new Unserved(payer.message, 402, 'wallet');
    throw Object.assign(new Unserved(`all providers failed: ${tried.join('; ')}${payer ? `; and ${payer.message}` : ''}`, 502, 'all_failed', { 'retry-after': '3' }), { asked: tried.length });
  }

  private async forward(cand: Candidate, body: Record<string, unknown>, wantsStream: boolean, res: ServerResponse, route: Route, fellThrough: number, retried = false, anth: Shape | null = null, state: StreamState = { started: false, stream: null, text: '', tools: false }, resumed = false): Promise<void> {
    const address = cand.entry.address;
    const maxOut = workOf(anth) ? workOut(anth, body) : Math.min(Number(body.max_completion_tokens ?? body.max_tokens ?? cand.offer.maxOutput), cand.offer.maxOutput);
    const maxCost = costOf(cand.offer.price, estimateInputTokens(body), maxOut);
    const beforeChannel = performance.now();
    const ch = await this.o.channels.ensure(address, maxCost);
    const channelMs = performance.now() - beforeChannel;
    const beforeSeal = performance.now();
    // Ids a client attached to say who is asking are dropped here, before anything leaves this machine, and the
    // answer names them (x-orrery-withheld) so the caller can see it happened.
    const withheld = anth?.withheld ?? identityIn(body);
    const withheldHeader: Record<string, string> = withheld.length ? { 'x-orrery-withheld': withheld.join(',') } : {};
    // Padded to its size class before anything else: sealed or not, its length says the class, not the prompt's length.
    // To a node that reads payment inside the seal, the channel and the voucher go there and not in headers, where the
    // node's hosting platform would read which channel (and so which wallet) each request is paid from.
    const inside = !!cand.entry.wireInside && (cand.sealed || !!cand.entry.wire);
    const payload = padRequest(Buffer.from(JSON.stringify({ ...withoutIdentity(body), model: cand.offer.id, stream: true, ...(inside ? { orrery: { channel: ch.channel, ...(ch.voucher ? { voucher: ch.voucher } : {}) } } : {}) }))).toString('utf8');
    let wire = payload;
    // What a sealed answer can say about where it ran: the enclave this router verified before it sealed the prompt.
    const ascii = (v: string) => v.replace(/[^\x20-\x7e]/g, "'");
    const enclave = cand.sealed && cand.entry.tee ? { kind: TEE_KINDS[cand.entry.account.teeKind] ?? 'enclave', image: Buffer.from(cand.entry.account.teeMeasurement).toString('hex').slice(0, 32), verdict: ascii(cand.entry.tee.reason) } : null;
    const enclaveHeaders: Record<string, string> = enclave ? { 'x-orrery-sealed': '1', 'x-orrery-enclave': enclave.kind, 'x-orrery-enclave-image': enclave.image, 'x-orrery-enclave-verdict': enclave.verdict } : {};
    let key: Buffer | null = null;
    let wired = false;
    // A node that has shown this router a signed wire key gets nothing in the clear when the key goes missing: a hosting
    // platform in front of it could hide /v1/wire to read the prompt and the payment. The next refresh asks again.
    if (!cand.sealed && !cand.entry.wire && this.o.registry.pinned(address)) {
      throw new Error('this node showed a signed wire key before and shows none now; nothing goes to it in the clear');
    }
    if (cand.sealed) {
      if (!cand.entry.tee?.verified) throw new Error('enclave not verified');
      const s = sealRequest(cand.entry.tee.enclaveKey, Buffer.from(payload));
      wire = s.body;
      key = s.key;
    } else if (cand.entry.wire) {
      // Not an enclave, but the node has a key of its own: the request and the answer are ciphertext to everything
      // between this router and the node process.
      const s = sealRequest(cand.entry.wire, Buffer.from(payload), 'wire');
      wire = s.body;
      key = s.key;
      wired = true;
    }
    const sealMs = performance.now() - beforeSeal;
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(inside ? {} : { 'x-orrery-channel': ch.channel }) };
    if (ch.voucher && !inside) headers['x-orrery-voucher'] = ch.voucher;
    const t0 = Date.now();
    const sent = performance.now();
    let nodeMs = 0;
    this.inflight.set(address, maxCost);
    const r = await fetchNode(`${cand.entry.account.endpoint.replace(/\/$/, '')}/v1/${kindPath(workOf(anth) ?? 'chat')}`, { method: 'POST', headers, body: wire, timeoutMs: 20_000 });
    if ((r.status === 404 || r.status === 409) && !retried) {
      const code = ((await r.json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      // The node restarted with a new wire key: read it again (signature checked as before) and send once more.
      if (code === 'wire_key' && wired) {
        await this.o.registry.refreshWire(address);
        return this.forward(cand, body, wantsStream, res, route, fellThrough, true, anth, state, resumed);
      }
      // The channel is gone (the node released it) or closing: let it go and send once more, on a fresh one. Without
      // this the router kept sending on the old channel, and failing, until its own check came round minutes later.
      if (code === 'unknown_channel' || code === 'channel_closing') {
        this.log(`${cand.entry.manifest?.name ?? address.slice(0, 6)} says channel ${ch.channel.slice(0, 6)} is ${code === 'unknown_channel' ? 'gone' : 'closing'}; going again on a fresh one`);
        this.o.channels.forget(address);
        return this.forward(cand, body, wantsStream, res, route, fellThrough, true, anth, state, resumed);
      }
      throw new Error(`provider answered ${r.status}${code ? ` (${code})` : ''}`);
    }
    if (r.status === 402 && !retried) {
      const j = (await r.json()) as { error: { code: string; box?: string; unpaid?: { requestId: string; model: string; inputTokens: number; outputTokens: number; cost: string }[]; need?: string } };
      // A node that read payment inside the seal seals what its refusal says about the channel: open it with this request's key.
      if (j.error.box && key) {
        try {
          Object.assign(j.error, JSON.parse(decrypt(key, Buffer.from(j.error.box, 'base64')).toString('utf8')));
        } catch {
          // Left as it came: the refusal below names the code.
        }
      }
      if (j.error.code === 'payment_required' && j.error.unpaid?.length === 1) {
        const u = j.error.unpaid[0];
        const allowed = this.inflight.get(address) ?? 0n;
        if (BigInt(u.cost) <= allowed && u.model === cand.offer.id) {
          this.o.channels.settle(address, { ...u, cost: BigInt(u.cost) });
          return this.forward(cand, body, wantsStream, res, route, fellThrough, true, anth, state, resumed);
        }
      }
      if (j.error.code === 'channel_exhausted') {
        await this.o.channels.topUp(address, BigInt(j.error.need ?? '0'));
        return this.forward(cand, body, wantsStream, res, route, fellThrough, true, anth, state, resumed);
      }
      throw new Error(`payment refused: ${j.error.code}`);
    }
    if (!r.ok || !r.body) {
      // The node's code says what kind of failure it was (context_length_exceeded, upstream_error); a body that is not
      // its JSON error is dropped unread.
      const code = r.ok ? null : ((await r.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code;
      if (r.ok) drop(r);
      if (r.status === 503 && code === 'busy') throw new NodeFull('provider answered 503 (busy): every slot was answering');
      throw new Error(`provider answered ${r.status}${typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : ''}`);
    }
    const theirs = nodeSaid(r.headers.get('server-timing'));

    let ttft = 0;
    let record: (UsageRecord & { owed: string }) | null = null;
    let claimedOff = 0;
    const chunks: Record<string, unknown>[] = [];
    // answerEvents stops handing out events at [DONE] and then reads the answer to its end, so the connection it
    // came on can carry the next request.
    for await (const ev of answerEvents(r.body)) {
      let data = ev.data;
      if (key) data = decrypt(key, Buffer.from(data, 'base64')).toString('utf8');
      if (ev.event === 'orrery') {
        const y = JSON.parse(data);
        record = { requestId: y.requestId, model: y.model, inputTokens: y.inputTokens, outputTokens: y.outputTokens, cost: BigInt(y.cost), owed: y.owed };
        claimedOff = knownOff(cand.entry.manifest?.holder?.tiers, y.off);
        continue;
      }
      if (!ttft) {
        ttft = Date.now() - t0;
        nodeMs = performance.now() - sent;
      }
      if (wantsStream) {
        if (!state.started) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-orrery-provider': address, 'x-orrery-provider-name': nameHeader(cand.entry.manifest?.name), ...(fellThrough ? { 'x-orrery-skipped': String(fellThrough) } : {}), 'x-orrery-route': route, 'server-timing': serverTiming({ route: state.routeMs, channel: channelMs, seal: sealMs, node: nodeMs, ...theirs }), ...(key ? enclaveHeaders : {}), ...(wired ? { 'x-orrery-wire': '1' } : {}), 'x-orrery-payment': inside ? 'inside' : 'headers', ...withheldHeader });
          state.started = true;
          const emit = (event: string, d: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);
          if (anth) {
            state.stream = anth.kind === 'anthropic' ? new AnthropicStream(emit, anth.id, cand.offer.id, estimateInputTokens(body)) : new ResponsesStream(emit, anth.id, cand.offer.id);
            state.stream.start();
          }
        }
        const parsed = JSON.parse(data) as Chunk;
        for (const ch of parsed.choices ?? []) {
          if (ch.delta?.content) state.text += ch.delta.content;
          if (ch.delta?.tool_calls?.length) state.tools = true;
        }
        if (state.stream) state.stream.chunk(parsed);
        else {
          // The provider's own usage numbers stay here: the client gets the billed ones at the end, and only if it asked.
          const { usage, ...rest } = parsed as Chunk & { usage?: unknown; id?: string; created?: number };
          state.id ??= rest.id;
          state.created ??= rest.created;
          if (usage === undefined) res.write(sseFrame(data));
          else if (rest.choices?.length) res.write(sseFrame(JSON.stringify(rest)));
        }
      } else {
        chunks.push(JSON.parse(data));
      }
    }
    if (!record) throw new Error('provider closed the stream without a usage record');
    if (claimedOff < cand.off) {
      this.stats.penalize(address);
      this.log(`provider ${address.slice(0, 6)} lists a ${cand.off / 100}% holder price but applied ${claimedOff / 100}%; paying its number, counting it against its success rate`);
    }
    // Images and speech the router can count itself: no more images than came back, and the text it sent at the rule
    // the node bills with. A node that says more is paid for what arrived.
    const cap = workCap(anth?.kind, body, chunks[0]);
    const pay = capped(record, cap);
    if (pay.over) this.log(`provider ${address.slice(0, 6)} billed ${record.inputTokens}+${record.outputTokens} tokens for ${cap?.images !== undefined ? `${cap.images} image${cap.images === 1 ? '' : 's'} that came back` : 'the text this router sent'}; paying for ${pay.inputTokens}+${pay.outputTokens}`);
    const ours = costOf(discounted(cand.offer.price, claimedOff), pay.inputTokens, pay.outputTokens);
    const full = costOf(cand.offer.price, pay.inputTokens, pay.outputTokens);
    const saved = claimedOff && full > ours ? full - ours : 0n;
    const fair = record.cost <= ours && record.cost <= maxCost ? record.cost : ours < maxCost ? ours : maxCost;
    if (fair !== record.cost) this.log(`provider ${address.slice(0, 6)} billed ${record.cost} but its own prices say ${ours}; paying ${fair}`);
    const beforeSign = performance.now();
    const voucher = this.o.channels.settle(address, { ...record, cost: fair });
    const timing: Timing = { route: roundMs(state.routeMs ?? 0), channel: roundMs(channelMs), seal: roundMs(sealMs), node: roundMs(nodeMs), sign: roundMs(performance.now() - beforeSign), ...theirs };
    this.inflight.delete(address);
    const handed = fetchNode(`${cand.entry.account.endpoint.replace(/\/$/, '')}/orrery/voucher`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: inside && cand.entry.wire ? sealRequest(cand.entry.wire, Buffer.from(JSON.stringify({ channel: ch.channel, voucher })), 'wire').body : JSON.stringify({ channel: ch.channel, voucher }), timeoutMs: 5_000,
    }).then(finish).catch(() => undefined);
    this.handing.add(handed);
    void handed.finally(() => this.handing.delete(handed));
    this.stats.ok(address, ttft);
    this.o.registry.noteRequest(address, true);
    const trip: Trip = {
      at: Date.now(), model: cand.offer.id, route, provider: address, providerName: cand.entry.manifest?.name ?? address.slice(0, 6),
      inputTokens: record.inputTokens, outputTokens: record.outputTokens, cost: usd(fair), billed: usd(record.cost), listed: usd(ours), ttftMs: ttft, totalMs: Date.now() - t0, ms: timing, sealed: !!key && !wired, ...(wired ? { wire: true } : {}), ...(withheld.length ? { withheld } : {}), ...(key && enclave ? { enclave } : {}), ...(this.taskOf.get(res) ? { task: this.taskOf.get(res) } : {}), ...(this.agentOf.get(res) ? { agent: this.agentOf.get(res) } : {}), ...(workOf(anth) ? { kind: workOf(anth)! } : {}), fellThrough, off: claimedOff, ...(saved ? { saved: usd(saved) } : {}), ...(resumed ? { resumed: true } : {}), ...(cand.cached && !fellThrough ? { cacheKept: true } : {}),
    };
    this.trips.push(trip);
    if (this.trips.length > 500) this.trips.splice(0, this.trips.length - 500);
    appendTrip(home('router', 'trips.jsonl'), trip);
    this.log(`${route.padEnd(10)} ${cand.offer.id} → ${trip.providerName}  ${record.inputTokens}+${record.outputTokens} tok  $${trip.cost}  ttft ${ttft}ms${claimedOff ? `  holder −${claimedOff / 100}%` : ''}${wired ? '  wire' : key ? '  sealed' : ''}${withheld.length ? `  withheld ${withheld.join(',')}` : ''}${resumed ? '  resumed' : ''}${trip.cacheKept ? '  kept for its prompt cache' : ''}`);

    // What this answer sends to the burn: the node's pledged share of what it was just paid, shown only once this router
    // has verified on chain that the node keeps its pledge.
    const burnShare = burning(cand.entry) ? cand.entry.burn!.share : 0;
    const taskName = this.taskOf.get(res);
    const task = taskName ? this.tasks.spend(taskName, fair) : null;
    const agentName = this.agentOf.get(res);
    if (agentName) this.agents!.spend(agentName, fair);
    const agentNow = agentName ? this.agents!.left(agentName) : null;
    const orreryHeaders = { 'x-orrery-provider': address, 'x-orrery-provider-name': nameHeader(cand.entry.manifest?.name), ...(fellThrough ? { 'x-orrery-skipped': String(fellThrough) } : {}), 'x-orrery-route': route, 'x-orrery-cost': trip.cost, 'x-orrery-billed': usd(record.cost), 'x-orrery-listed': usd(ours), 'x-orrery-ttft-ms': String(ttft), 'server-timing': serverTiming(timing), ...(key ? enclaveHeaders : {}), ...(wired ? { 'x-orrery-wire': '1' } : {}), 'x-orrery-payment': inside ? 'inside' : 'headers', ...withheldHeader, ...(task ? taskHeaders(task) : {}), ...(agentNow ? agentHeaders(agentNow) : {}), ...(burnShare ? { 'x-orrery-burn': usd((fair * BigInt(burnShare)) / 10_000n), 'x-orrery-burn-share': String(burnShare) } : {}) };
    if (wantsStream) {
      if (state.stream) state.stream.finish(record.inputTokens, record.outputTokens);
      else {
        if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true) {
          res.write(sseFrame(JSON.stringify({ id: state.id ?? `chatcmpl-${trip.at}`, object: 'chat.completion.chunk', created: state.created ?? Math.floor(trip.at / 1000), model: cand.offer.id, choices: [], usage: billedUsage(record.inputTokens, record.outputTokens, trip.cost) })));
        }
        res.write(sseFrame('[DONE]'));
      }
      res.end();
      return;
    }
    if (anth?.kind === 'anthropic') return send(res, 200, toMessage(chunks, anth.id, cand.offer.id, record.inputTokens, record.outputTokens), orreryHeaders);
    if (anth?.kind === 'embeddings') return send(res, 200, { ...(chunks[0] ?? {}), model: cand.offer.id, usage: { prompt_tokens: record.inputTokens, total_tokens: record.inputTokens, cost: Number(trip.cost) } }, orreryHeaders);
    if (anth?.kind === 'speech') {
      // The audio came base64 in the node's one data event; it goes back as the bytes, with their type.
      const a = (chunks[0] ?? {}) as { audio?: string; contentType?: string };
      const bytes = Buffer.from(a.audio ?? '', 'base64');
      res.writeHead(200, { ...orreryHeaders, 'content-type': a.contentType ?? 'audio/mpeg', 'content-length': String(bytes.length), 'x-orrery-input-tokens': String(record.inputTokens) });
      res.end(bytes);
      return;
    }
    if (anth?.kind === 'image') {
      const made = (chunks[0] ?? {}) as { data?: unknown[] };
      return send(res, 200, { ...made, model: cand.offer.id, usage: { input_tokens: record.inputTokens, output_tokens: record.outputTokens, images: Array.isArray(made.data) ? made.data.length : 0, cost: Number(trip.cost) } }, orreryHeaders);
    }
    if (anth?.kind === 'rerank') return send(res, 200, { ...(chunks[0] ?? {}), model: cand.offer.id, usage: { total_tokens: record.inputTokens, cost: Number(trip.cost) } }, orreryHeaders);
    if (anth?.kind === 'responses') {
      const r = new ResponsesStream(null, anth.id, cand.offer.id);
      for (const c of chunks) r.chunk(c as Chunk);
      return send(res, 200, r.finish(record.inputTokens, record.outputTokens), orreryHeaders);
    }
    send(res, 200, { ...assemble(chunks, cand.offer.id, record.inputTokens, record.outputTokens), usage: billedUsage(record.inputTokens, record.outputTokens, trip.cost) }, orreryHeaders);
  }
}

/** OpenAI's usage object with the tokens this router paid for, plus what the answer cost in USDC (the field OpenRouter
 * calls usage.cost, so tools that already read it show the bill). */
export function billedUsage(prompt: number, completion: number, cost: string) {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost: Number(cost) };
}

/** Turn a provider's stream back into the single object a non-streaming OpenAI client expects. */
function assemble(chunks: Record<string, unknown>[], model: string, prompt: number, completion: number) {
  const choices = new Map<number, { index: number; message: { role: string; content: string; tool_calls?: unknown[] }; finish_reason: string | null }>();
  for (const c of chunks) {
    for (const ch of (c.choices as { index?: number; delta?: { role?: string; content?: string; tool_calls?: unknown[] }; finish_reason?: string | null }[] | undefined) ?? []) {
      const i = ch.index ?? 0;
      const cur = choices.get(i) ?? { index: i, message: { role: 'assistant', content: '' }, finish_reason: null };
      if (ch.delta?.content) cur.message.content += ch.delta.content;
      for (const t of (ch.delta?.tool_calls ?? []) as { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[]) {
        const calls = (cur.message.tool_calls ??= []) as { index: number; id?: string; type: string; function: { name: string; arguments: string } }[];
        const k = t.index ?? 0;
        let c = calls.find((x) => x.index === k);
        if (!c) calls.push((c = { index: k, id: t.id, type: t.type ?? 'function', function: { name: '', arguments: '' } }));
        if (t.id) c.id = t.id;
        if (t.function?.name) c.function.name += t.function.name;
        if (t.function?.arguments) c.function.arguments += t.function.arguments;
      }
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
    choices: [...choices.values()].sort((a, b) => a.index - b.index).map((c) => (c.message.tool_calls ? { ...c, message: { ...c.message, tool_calls: (c.message.tool_calls as { index: number }[]).map(({ index: _i, ...t }) => t) } } : c)),
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

/** Why the private route had nowhere to go: each node that claims an enclave, and the check that stopped it. */
function whyNotPrivate(offers: { entry: { manifest: { name: string } | null; address: string; tee: { verified: boolean; reason: string } | null } }[]): string {
  const claims = offers.filter((o) => o.entry.tee && !o.entry.tee.verified).slice(0, 3).map((o) => `${o.entry.manifest?.name ?? o.entry.address.slice(0, 6)}: ${o.entry.tee!.reason}`);
  return claims.length ? ` (${claims.join('; ')})` : '';
}
