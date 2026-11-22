#!/usr/bin/env node
import { refusedText } from './provider/refusal.ts';
import { loadWatched, sawLine, sawText } from './router/watched.ts';
import { rpcConnection } from './chain/connect.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { sendOne } from './chain/send.ts';
import { CLI, NAME, PROVIDER_PORT, ROUTER_PORT, USDC_MAINNET } from './brand.ts';
import { ACCOUNT, decodeChannel, decodeConfig, decodeProvider, ins, pda, programId, type ChannelAccount } from './chain/program.ts';
import { checkVouchers, renderVouchers } from './provider/vouchers.ts';
import { home, loadKeypair, loadOrCreateKeypair } from './keys.ts';
import { newWallet, walletNextSteps } from './wallet.ts';
import { HolderBook, sharePct, type HolderTier } from './holder.ts';
import { estimateInputTokens, perMillion, usd } from './pricing.ts';
import { feesLine, FEE_FLOOR_LAMPORTS, ProviderNode, REDEEM_FEE_LAMPORTS, REDEEM_MIN_UNITS, type ProviderConfig } from './provider/node.ts';
import { Channels } from './router/channels.ts';
import { parseAliases, parseCeiling, ROUTES, Stats, type Route } from './router/policy.ts';
import { Registry } from './router/registry.ts';
import { Router } from './router/server.ts';
import { serveMcp } from './mcp.ts';
import { CACHE_REPORTING, draftConfig, draftWallet, holderTiersNote, SOLANA_WALLET, walletNote, findUpstream, isEmbeddingModel, isImageModel, isRerankModel, isSpeechModel, nextSteps, OLLAMA_NOTE } from './provider/init.ts';
import { CLIENTS, codexProfile, contextFromRouter, instructions, routerNote, startRouter, USUAL_MODEL, type Client } from './connect.ts';
import { spawn } from 'node:child_process';
import { pickModel, plan, planCommand, readBill, renderBill, routerModels, RUNNABLE, taskName, type Runnable } from './run.ts';
import { doctor, render } from './doctor.ts';
import { bills, heldGivenLine, heldSaved, heldSavedLine, paidInside, readTrips, rowsByKind, sealedTrips, skipNote, skipped, spendCsv, spentMonthLine, spentThisMonth, summarize, windowMs, readUnanswered, unansweredIn, unansweredNote } from './spend.ts';
import { bench, median, renderBench } from './bench.ts';
import { quote, quoteKind, renderQuote } from './quote.ts';
import { IMAGE_TOKENS, imageCount, kindPath, speechTokens, type ModelKind } from './manifest.ts';
import { compare, renderCompare } from './provider/compare.ts';
import { parseFirmware, parseSnpReport, verifySnp } from './tee/snp.ts';
import { LISTING_BYTES, nextStep, privateAddress, providerCheck, fundKeyLamports, fundKeyNote, TOKEN_ACCOUNT_BYTES, registerProblem, renderCheck, listingLine, listingState } from './provider/check.ts';
import { consoleLine, dayLine, kindsLine, monthLine, nextPayoutHint, payoutHint, readOwnDay, readOwnMonth, readOwnStatus } from './provider/console.ts';
import { slotsLine } from './provider/slots.ts';
import { AgentBook, parseAgentCaps, parseAgentModels } from './router/agents.ts';
import { checkPayouts, nextPayoutSentence, noticeLine, payoutFailedSentence, notifyUrl, paidOutLine, payoutCheckLines, payoutLines, payoutsCsv, readPayouts, walletLine } from './provider/payouts.ts';
import { booksByDay, booksByDayCsv, booksByDayLines, booksByMonth, readDays } from './provider/books.ts';
import { reachLine } from './provider/reach.ts';
import { composeFile } from './provider/compose.ts';
import { reprice, renderReprice } from './provider/reprice.ts';
import { parseTdxQuote, tdxFmspc, verifyTdx } from './tee/tdx.ts';
import { auditEnclave, renderChecks } from './tee/audit.ts';
import { fetchCrls } from './tee/crl.ts';
import { nodeProxy, parseProxy, proxyAnswers, setNodeProxy } from './proxy.ts';
import { fetchTcbInfo } from './tee/tcb.ts';
import { burnDue, loadBook, splBurner } from './burn.ts';
import { jupQuote, jupiterSwapper } from './burn-jupiter.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);
const expand = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
/** Where a node's wallet is, for the register step: the file the config names is on this computer, or the node knows
 * the wallet only by its address ("authority", or ORRERY_AUTHORITY in a container) and the file, if any, is elsewhere. */
const walletWhere = (cfg: { wallet?: string; authority?: string }) => {
  const here = !!cfg.wallet && existsSync(expand(cfg.wallet));
  const byAddress = !here && !!(cfg.authority || process.env.ORRERY_AUTHORITY);
  return { walletInConfig: here, ...(byAddress ? { walletAway: cfg.wallet ?? '' } : {}) };
};
/** The wallet a command uses: --wallet, then ORRERY_WALLET, then the one `orrery wallet new` made in the home folder. */
const walletFlag = () => flag('wallet', process.env.ORRERY_WALLET) ?? (existsSync(home('wallet.json')) ? home('wallet.json') : undefined);
const rpc = () => flag('rpc', process.env.ORRERY_RPC_URL ?? 'https://api.mainnet-beta.solana.com')!;
const mint = () => new PublicKey(flag('mint', process.env.ORRERY_SETTLE_MINT ?? USDC_MAINNET)!);
const dollars = (s: string) => BigInt(Math.round(Number(s) * 1e6));

const HELP = `${NAME} — peer-to-peer AI inference, settled on Solana

  First time?
  ${CLI} wallet new               makes a wallet file and says what to send it (skip this if you have a Solana keypair file)
  ${CLI} router                   uses that wallet; then point any OpenAI-compatible tool at http://127.0.0.1:${ROUTER_PORT}/v1
  ${CLI} doctor                   reads the chain, the nodes, your wallet and your router, and says what is ready
  (--wallet <file> on either picks another wallet, such as a Solana keypair file you already have)

  ${CLI} router                 run the router on http://127.0.0.1:${ROUTER_PORT}/v1
      --wallet <keypair.json>   wallet that opens channels (signs once per provider)
      --route <${ROUTES.join('|')}>   default route (per request: model suffix :cheap :fast :trusted :private)
      --deposit <usd>           deposit per new channel (default 2)
      --daily-cap <usd>         stop spending after this much per day (default 5)
      --max-price <in/out>      never route above this price, dollars per million tokens, e.g. 0.50/1.50 (per request: x-orrery-max-price)
      --max-cost <usd>          a dollar budget for each request, e.g. 0.002 (per request: x-orrery-max-cost)
      --agent-cap <name=usd,…>  a spending limit per UTC day for each named agent, e.g. researcher=0.50,coder=2 (an agent names itself with x-orrery-agent or the key agent/<name>)
      --agent-models <name=m|m,…>  the models each named agent may use, e.g. coder=qwen3-coder-30b|deepseek-v3; others are refused (env ORRERY_AGENT_MODELS)
      --private-only            seal every request to a verified enclave or refuse it; no suffix or header can turn it off
      --patience <seconds>      how long a request waits and asks again when no node can be reached (default 8, 0 fails at once)
      --proxy <url>             reach nodes and the Solana RPC through this proxy (http://host:port or socks5://host:port), so they see its address and not yours; no direct fallback (env ORRERY_PROXY)
      --min-reputation <0-1>    auto route ignores providers below this (default 0.2)
      --alias <from=to,...>     answer other model names with a network model, e.g. 'claude-*=llama-3.3-70b'
      --enclave-images <hex,...> only seal prompts to enclaves that booted one of these images
      --min-firmware <b.t.s.m>  refuse AMD enclaves below this firmware level, e.g. 3.0.8.115 (env ORRERY_SNP_MIN_FIRMWARE)
      --allow-outdated          accept Intel enclaves that Intel lists as out of date (refused by default)
      --allow-dev-enclaves      accept software attestation (local testing only)
  ${CLI} mcp                     an MCP server on stdio for agents, in front of your running router
      --router <url>            the router to use (default http://127.0.0.1:${ROUTER_PORT})
      --agent <name>            name every call with this agent, for the router's --agent-cap limits (env ORRERY_AGENT)
  ${CLI} connect <${CLIENTS.join('|')}>   the settings a client needs to use your router
      --model <id>              network model to use (default gpt-oss-120b)   --router <url>
      --agent <name>            settings that make every request as this agent, for the router's --agent-cap
      --write                   codex only: write $CODEX_HOME/orrery.config.toml (your config.toml is left alone)
  ${CLI} run claude [--budget <usd>] [--task <name>] [--model <id>] [-- <its own arguments>]   start Claude Code on your router as one job, and print the job's bill when it exits
  ${CLI} run [--budget <usd>] [--task <name>] -- <any command>   the same for any tool that reads OPENAI_BASE_URL or ANTHROPIC_BASE_URL: the job and its budget ride in the API key (orrery/<task>/<budget>)
  ${CLI} bench <model> [--n 3] [--json]   ask every provider of a model a few short questions through your router (paid) and compare
  ${CLI} spend [--since 24h|7d] [--by model|provider|task|agent|kind|day] [--csv|--json]   what your router paid, from its own log of answers; by agent, each agent's bill; by day, your books
  ${CLI} sealed [--since 30d] [--json]   every private answer your router paid for: the enclave it verified, the image, the verdict
  ${CLI} doctor [--wallet <keypair.json> | --address <pubkey>] [--json]   check the RPC, the program, every listing, a wallet and the router (reads only)
  ${CLI} models                  every model on the network, cheapest price, provider count
  ${CLI} wallet new [--out <file>]   a new wallet file (default ~/.orrery/wallet.json) and what to send it; ${CLI} wallet address prints a wallet's address
  ${CLI} quote <model> [--in 2000 | --prompt "..."] [--out 500] [--cached 0.8] [--json]   what one request costs at every provider, from prices on chain (nothing is sent or paid)
  ${CLI} enclave verify --node <listing> | --report <file> --vcek <file> | --quote <file>   audit a private node, or check an AMD SEV-SNP report or Intel TDX quote, here, against the chip maker’s roots
  ${CLI} providers               every listed provider, what the chain says about it, and whether its model server answers
  ${CLI} channels [--wallet <keypair.json> | --address <pubkey>]   your router's channels and what the chain says about each, plus any it has no record of
  ${CLI} close <channel> --wallet <keypair.json>            start closing (the provider keeps a grace period)
  ${CLI} close <channel> --wallet <keypair.json> --finish   after the grace period: the rest comes back to you
  ${CLI} provider init [--notify <webhook url>|--notify-env <VAR>] [--no-holder-prices]   find a local model server (Ollama, vLLM, llama.cpp, LM Studio, SGLang) and write provider.json; a webhook gets each payout as it lands
      --upstream <url> --name <name> --public-url <url> --out <file> --force
  ${CLI} provider burn    --config provider.json [--yes]   what your burn pledge owes now; with --yes, buy the network token with it and burn it
  ${CLI} provider check   --config provider.json [--json]   is this node ready to earn: model server, public address, listing, fee money, enclave, pledge
  ${CLI} provider start   --config provider.json
  ${CLI} provider compose --config provider.json [--out docker-compose.yml] [--print]   a docker-compose file that runs this node in a container
  ${CLI} provider console --config provider.json   the address of this node's console, with its key (on this computer only)
  ${CLI} provider status  --config provider.json [--json]   what the console shows, in this terminal: answers, signed, redeemed, waiting, fee SOL
  ${CLI} provider register --config provider.json [--wallet <keypair.json>] [--fund-key [sol]] [--private-address]   list or update on chain; --fund-key also sends the node’s key fee money
  ${CLI} provider attest  --config provider.json   post the enclave claim (node key signs)
  ${CLI} provider redeem  --config provider.json   redeem every channel now
  ${CLI} provider earnings --config provider.json [--since 24h] [--by model|channel|kind|day|month] [--csv|--json]   what this node billed, from its own log; by day or month, what each billed and paid out
  ${CLI} provider vouchers --config provider.json [--json]   every voucher this node holds, checked against its channel on chain the way the program checks a redeem
  ${CLI} provider payouts --config provider.json [--last 5] [--json|--csv]   each payout this node kept, checked against what the chain says reached your wallet
  ${CLI} provider price  --config provider.json [--beat 5] [--floor <in/out>] [--write]   undercut the cheapest other listing by a margin, never below your floor
  ${CLI} provider compare --config provider.json [--json]   your prices next to every other listing of the same models

  --rpc <url>   Solana RPC (or ORRERY_RPC_URL)     --mint <address>  settlement mint (default USDC)
`;

async function router() {
  const proxy = nodeProxy();
  if (proxy && !(await proxyAnswers(proxy))) throw new Error(`nothing answers at the proxy ${proxy.label}; start it first. The router does not fall back to reaching nodes directly`);
  const conn = rpcConnection(rpc());
  const walletPath = walletFlag();
  const wallet = walletPath ? loadKeypair(expand(walletPath)) : null;
  const session = loadOrCreateKeypair(home('router', 'session.json'));
  const route = (flag('route', 'auto') as Route);
  if (!ROUTES.includes(route)) throw new Error(`unknown route ${route}`);
  const minFirmware = flag('min-firmware') ? parseFirmware(flag('min-firmware')!) : null;
  if (flag('min-firmware') && !minFirmware) throw new Error('--min-firmware is four numbers: <boot loader>.<tee>.<snp>.<microcode>, e.g. 3.0.8.115');
  const registry = new Registry(conn, { allowDev: has('allow-dev-enclaves'), measurements: (flag('enclave-images', '') ?? '').split(',').filter(Boolean), minFirmware, allowOutdated: has('allow-outdated') }, home('router', 'pins.json'), home('router', 'watched.json'));
  const channels = new Channels(conn, wallet, session, mint(), home('router', 'channels.json'), {
    deposit: dollars(flag('deposit', '2')!), topUpBelow: dollars(flag('top-up-below', '0.25')!), dailyCap: dollars(flag('daily-cap', '5')!),
  });
  const port = Number(flag('port', String(ROUTER_PORT)));
  const r = new Router({ port, route, minReputation: Number(flag('min-reputation', '0.2')), registry, channels, conn, refreshSecs: Number(flag('refresh', '60')), patienceMs: Math.max(0, Number(flag('patience', '8'))) * 1000, holders: new HolderBook(conn, 60_000, undefined, { serveStale: true }), aliases: parseAliases(flag('alias', process.env.ORRERY_ALIASES)), maxPrice: parseCeiling(flag('max-price', process.env.ORRERY_MAX_PRICE)), maxCost: flag('max-cost', process.env.ORRERY_MAX_COST) || undefined, agentCaps: parseAgentCaps(flag('agent-cap', process.env.ORRERY_AGENT_CAPS)), agentModels: parseAgentModels(flag('agent-models', process.env.ORRERY_AGENT_MODELS)), privateOnly: has('private-only') || process.env.ORRERY_PRIVATE_ONLY === '1', observedPath: home('router', 'observed.json') });
  await r.start();
  // The proxy is checked from the far side before anything is paid for: a node says what address it saw.
  const far = await r.checkProxy();
  if (far?.givenAway) {
    await r.close();
    throw new Error(`${far.line}. The router does not run behind a proxy that gives this computer's address away`);
  }
  // Told to stop (Ctrl-C, or a container being replaced), the router lets answers in flight finish and hands over the
  // vouchers still on their way before it goes. Asked again a moment later, it stops at once. (A launcher such as
  // npx passes the same signal on, so one that arrives within a second of the first is the first.)
  let stopping = 0;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping && Date.now() - stopping > 1_000) process.exit(130);
      if (stopping) return;
      stopping = Date.now();
      void r.drain(20_000).then((left) => {
        if (left) console.log(`stopped with ${left} still in flight; a node may be owed for an answer it has no voucher for yet (the next request to it pays)`);
        process.exit(0);
      });
    });
  }
  const usable = registry.usable().length;
  if (proxy) console.log(`nodes and the Solana RPC are reached through the proxy at ${proxy.label}. ${far ? far.line[0].toUpperCase() + far.line.slice(1) : ''}`);
  if (has('private-only') || process.env.ORRERY_PRIVATE_ONLY === '1') console.log('private only: every request is sealed to an enclave this router verified, or refused');
  console.log(`${NAME} router on http://127.0.0.1:${port}/v1  ·  ${usable} providers  ·  route ${route}  ·  ${wallet ? `wallet ${wallet.publicKey.toBase58().slice(0, 6)}…` : 'no wallet (read-only)'}`);
  // Said once, so nobody wonders which wallet is paying: the one in the home folder was picked up, not passed in.
  if (wallet && !flag('wallet', process.env.ORRERY_WALLET)) console.log(`using the wallet in ${home('wallet.json')} (made by ${CLI} wallet new); --wallet <file> uses another`);
  console.log(`session key ${session.publicKey.toBase58()} signs vouchers; console at http://127.0.0.1:${port}/`);
  const s = await r.standing();
  if (s && s.balance > 0n) {
    const at = registry.usable().filter((e) => e.manifest?.holder?.tiers.some((t) => s.balance * 10_000n >= s.supply * BigInt(t.share))).length;
    console.log(`holder: this wallet holds ${sharePct(s)} of the network token's supply · holder prices at ${at} provider${at === 1 ? '' : 's'}`);
  }
}

/** What `orrery models` says beside a model listed for a kind of work other than chat: where it is sent, and for speech
 * what it is billed on. */
const modelsKindNote = (kind: ModelKind, cheapest?: { input: number; output: number }) => `${kind} (/v1/${kindPath(kind)}${kind === 'speech' ? `, billed on the text: one input token per 4 characters${cheapest ? `, from $${(cheapest.input / 4 / 1e6).toFixed(2)} per million characters` : ''}` : kind === 'image' ? `, billed as 1,000 output tokens an image${cheapest ? `, from $${((cheapest.output * IMAGE_TOKENS) / 1e12).toFixed(4)} an image` : ''}` : ''})`;

async function listModels() {
  const registry = new Registry(rpcConnection(rpc()), { allowDev: has('allow-dev-enclaves'), measurements: [] });
  await registry.refresh();
  const rows = registry.catalog();
  if (!rows.length) return console.log('No models listed yet.');
  for (const m of rows) console.log(`${m.id.padEnd(40)} ${String(m.providers).padStart(3)} ${m.providers === 1 ? 'provider ' : 'providers'}  from ${perMillion(m.cheapest.input)} in · ${perMillion(m.cheapest.output)} out${m.cachedFrom !== null ? ` · cached in from ${perMillion(m.cachedFrom)}` : ''}${m.private ? `  · ${m.private} private` : ''}${m.kind ? `  · ${modelsKindNote(m.kind, m.cheapest)}` : ''}`);
}

const tiersText = (t?: HolderTier[]) => (t?.length ? `holders ${t.map((x) => `${x.share / 100}%→−${x.off / 100}%`).join(' ')}  ` : '');

async function listProviders() {
  const registry = new Registry(rpcConnection(rpc()), { allowDev: has('allow-dev-enclaves'), measurements: [] });
  await registry.refresh();
  await registry.checkHealth();
  const serverText = (e: { upstream?: 'up' | 'down'; healthMs?: number }) => (e.upstream === 'up' ? `model server up (${e.healthMs} ms)  ` : e.upstream === 'down' ? 'model server down, routers skip it  ' : '');
  // What this computer's router saw of each node, from the records it keeps in its home: no request is made for it.
  const watched = loadWatched(home('router', 'watched.json'));
  const seen = new Stats(home('router', 'observed.json'));
  // And each node's bills against the prices it listed, from the router's log of the answers it paid for.
  const billsBy = new Map(bills(readTrips(home('router', 'trips.jsonl')), 86_400_000).map((x) => [x.provider, x]));
  for (const e of registry.entries.values()) {
    const a = e.account;
    console.log(`${e.address}  ${(e.manifest?.name ?? '?').padEnd(24)} ${a.active ? 'open  ' : 'closed'}  settled $${usd(a.settled, 2)} in ${a.redeems} redeems  ${e.manifest?.models.length ?? 0} models  ${serverText(e)}${e.manifest?.burn ? `pledges ${e.manifest.burn.share / 100}% to the burn  ` : ''}${tiersText(e.manifest?.holder?.tiers)}${e.tee ? `enclave: ${e.tee.reason}` : ''}${e.problem ? `  ✗ ${e.problem}` : ''}`);
    const saw = sawLine(watched.get(e.address), seen.all().get(e.address), Date.now(), billsBy.get(e.address));
    if (saw) console.log(`    ${saw}`);
  }
}

async function listChannels() {
  const conn = rpcConnection(rpc());
  const session = loadOrCreateKeypair(home('router', 'session.json'));
  const local = new Channels(conn, null, session, mint(), home('router', 'channels.json'), { deposit: 0n, topUpBelow: 0n, dailyCap: 0n }).list();
  const walletPath = walletFlag();
  const address = flag('address') ?? (walletPath ? loadKeypair(expand(walletPath)).publicKey.toBase58() : null);
  const rows = new Map<string, { a: ReturnType<typeof decodeChannel> | null; signed: bigint | null }>();
  for (const c of local) {
    const info = await conn.getAccountInfo(new PublicKey(c.channel));
    rows.set(c.channel, { a: info ? decodeChannel(info.data) : null, signed: c.cumulative });
  }
  if (address) {
    // The chain also knows the channels this router has no record of (a new machine, a wiped home folder).
    const found = await conn.getProgramAccounts(programId(), {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Channel).toString('base64'), encoding: 'base64' } },
        { memcmp: { offset: 8, bytes: new PublicKey(address).toBase58() } },
      ],
    });
    for (const f of found) if (!rows.has(f.pubkey.toBase58())) rows.set(f.pubkey.toBase58(), { a: decodeChannel(f.account.data), signed: null });
  }
  if (!rows.size) {
    console.log(`No channels yet. The first request to a provider opens one.${address ? '' : ` Add --wallet <keypair.json> or --address <pubkey> to look on chain as well as in ${home('router', 'channels.json')}.`}`);
    return;
  }
  // What is unspent in a channel comes back with its deposit when it is closed: the deposit less what this router
  // signed, or, for a channel it has no record of, at most the deposit less what the node has redeemed.
  let unspentAll = 0n, open = 0, guessed = false;
  for (const [channel, { a, signed }] of rows) {
    if (!a) {
      console.log(`${channel}  closed`);
      continue;
    }
    const state = a.closingAt === 0n ? 'open' : `closing, ready after ${new Date(Number(a.closingAt) * 1000).toISOString()}`;
    const head = `${channel}  provider ${a.provider.toBase58().slice(0, 8)}…  deposit $${usd(a.deposit, 2)}  redeemed $${usd(a.redeemed)}  ${state}`;
    open++;
    if (signed !== null) {
      const unspent = a.deposit > signed ? a.deposit - signed : 0n;
      unspentAll += unspent;
      console.log(`${head}  you signed $${usd(signed)}  unspent $${usd(unspent)}`);
      continue;
    }
    const upTo = a.deposit > a.redeemed ? a.deposit - a.redeemed : 0n;
    unspentAll += upTo;
    guessed = true;
    const mine = a.sessionKey.equals(session.publicKey);
    const note = a.closingAt !== 0n
      ? 'not in your records'
      : mine
        ? 'not in your records; the router picks it back up on its next request to this provider'
        : `not in your records and signed by another session key; to get the deposit back: ${CLI} close ${channel} --wallet <keypair.json>`;
    console.log(`${head}  unspent up to $${usd(upTo)}  ${note}`);
  }
  if (open) console.log(`Unspent: ${guessed ? 'up to ' : ''}$${usd(unspentAll)} across ${open} channel${open === 1 ? '' : 's'}. Closing one gives its unspent deposit and its account rent back to the wallet that opened it: ${CLI} close <channel>`);
  if (!address) console.log(`Add --wallet <keypair.json> or --address <pubkey> to include channels this router has no record of.`);
}

async function provider(sub: string) {
  const cfgPath = flag('config');
  if (!cfgPath) throw new Error('--config <provider.json> is required');
  const cfg = JSON.parse(readFileSync(expand(cfgPath), 'utf8')) as ProviderConfig;
  cfg.rpcUrl = flag('rpc', process.env.ORRERY_RPC_URL ?? cfg.rpcUrl) ?? cfg.rpcUrl;
  cfg.listen = Number(flag('port', process.env.PORT ?? '')) || cfg.listen || PROVIDER_PORT;
  // Where the model server is, when that differs from the config: a node in a container reaches one on its host this way.
  if (process.env.ORRERY_UPSTREAM_URL) cfg.upstream.baseUrl = process.env.ORRERY_UPSTREAM_URL;
  if (sub === 'compose') {
    // A docker-compose file for this node: the official Node image running this package, nothing built or hosted by us.
    const out = flag('out', 'docker-compose.yml')!;
    const raw = JSON.parse(readFileSync(expand(cfgPath), 'utf8')) as ProviderConfig;
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
    // The package the container runs: this version from npm, or what --package names (a pinned version, a packed file).
    const pkg = flag('package', `orrery-node@${version}`)!;
    // The wallet stays on this computer; the container node gets its address, read here from the file the config names.
    const walletFile = !raw.authority && raw.wallet ? expand(raw.wallet) : null;
    const authority = raw.authority ? undefined : walletFile && existsSync(walletFile) ? loadKeypair(walletFile).publicKey.toBase58() : undefined;
    if (!raw.authority && !authority) console.log(`note: the node in the container needs its wallet’s address: put it in "authority" in ${cfgPath}${walletFile ? ` (there is no wallet at ${raw.wallet} to read it from)` : ''}`);
    const text = composeFile({ cfg: raw, configPath: resolvePath(expand(cfgPath)), home: process.env.HOME ?? '/root', pkg, port: cfg.listen, authority });
    if (has('print')) return console.log(text);
    // A node told to listen on this computer only would do the same inside the container, where nothing could reach it.
    if (/^(127\.0\.0\.1|localhost|::1)$/.test((raw as { host?: string }).host ?? '')) console.log(`note: "host": "${(raw as { host?: string }).host}" in ${cfgPath} makes the node listen inside the container only; remove it so routers can reach the node`);
    if (existsSync(out) && !has('force')) throw new Error(`${out} exists; pass --force to replace it`);
    writeFileSync(out, text);
    return console.log(`wrote ${out}. Start the node with: docker compose up -d\nIts numbers, from inside the container: docker compose exec node npx -y --package=${pkg} orrery provider status --config ${resolvePath(expand(cfgPath))}`);
  }
  if (sub === 'compare') {
    const registry = new Registry(rpcConnection(cfg.rpcUrl ?? rpc()), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    // This node's own listing is left out of the others: named by "authority", or by the wallet that lists it.
    const self = cfg.authority ? pda.provider(new PublicKey(cfg.authority)).toBase58() : cfg.wallet && existsSync(expand(cfg.wallet)) ? pda.provider(loadKeypair(expand(cfg.wallet)).publicKey).toBase58() : null;
    const rows = compare(cfg.models.map((m) => ({ id: m.id, price: m.price, kind: m.kind })), registry.usable(), self);
    if (has('json')) return console.log(JSON.stringify(rows.map((r) => ({ ...r, myCost: usd(r.myCost), lowestCost: r.lowestCost === null ? null : usd(r.lowestCost) })), null, 2));
    return console.log(renderCompare(cfg.name, rows));
  }
  if (sub === 'price') {
    // orrery provider price --config provider.json [--beat 5] [--floor 0.02/0.08] [--write]
    const registry = new Registry(rpcConnection(cfg.rpcUrl ?? rpc()), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    const self = cfg.authority ? pda.provider(new PublicKey(cfg.authority)).toBase58() : null;
    const beatPct = Number(flag('beat', '5'));
    if (!Number.isFinite(beatPct) || beatPct < 0 || beatPct >= 100) throw new Error('--beat is a percentage under the cheapest listing, 0 to 99');
    const rows = reprice(cfg.models.map((m) => ({ id: m.id, price: m.price })), registry.usable(), self, { beatPct, floor: parseCeiling(flag('floor')) });
    if (has('json')) return console.log(JSON.stringify(rows, null, 2));
    const write = has('write') && rows.some((r) => r.changed);
    if (write) {
      // Only the prices change in the file; everything else is written back as it was read.
      const raw = JSON.parse(readFileSync(expand(cfgPath), 'utf8')) as ProviderConfig;
      for (const r of rows) if (r.changed) raw.models.find((m) => m.id === r.model)!.price = r.to;
      writeFileSync(expand(cfgPath), `${JSON.stringify(raw, null, 2)}\n`);
    }
    return console.log(renderReprice(cfg.name, rows, write));
  }
  if (sub === 'earnings') {
    const by = flag('by', 'model') === 'channel' ? 'provider' : 'model';
    // By kind: the rows by model folded by what each model does in this node's listing (chat, embeddings, rerank).
    const byKind = flag('by') === 'kind';
    const label = byKind ? 'kind' : by === 'provider' ? 'channel' : 'model';
    const since = flag('since', '24h')!;
    const log = `${expand(cfg.dataDir ?? home('provider'))}/served.jsonl`;
    const summed = summarize(readTrips(log), by, windowMs(since));
    const total = summed.total;
    const rows = byKind ? rowsByKind(summed.rows, cfg.models) : summed.rows;
    // What has already landed in the wallet: the listing on chain counts every payout and what they settled.
    const onChain = async (): Promise<{ payouts: number; settled: string } | null> => {
      try {
        const authority = cfg.authority ? new PublicKey(cfg.authority) : loadKeypair(expand(cfg.wallet ?? `${expand(cfg.dataDir ?? home('provider'))}/wallet.json`)).publicKey;
        const listing = await rpcConnection(cfg.rpcUrl ?? rpc()).getAccountInfo(pda.provider(authority));
        if (!listing) return null;
        const p = decodeProvider(listing.data);
        return { payouts: Number(p.redeems), settled: usd(p.settled) };
      } catch {
        // The log stands on its own; the chain is added when the listing can be read.
        return null;
      }
    };
    const landed = async () => {
      const c = await onChain();
      if (c) console.log(`on chain: ${c.payouts} payout${c.payouts === 1 ? '' : 's'} to your wallet so far, $${c.settled} settled`);
    };
    const payoutsPath = `${expand(cfg.dataDir ?? home('provider'))}/payouts.jsonl`;
    // When the rest reaches the wallet: asked of the node running on this computer, with the key in its folder.
    const nextOut = async () => {
      const key = (() => {
        try {
          return readFileSync(`${expand(cfg.dataDir ?? home('provider'))}/console.key`, 'utf8').trim();
        } catch {
          return '';
        }
      })();
      const own = /^[0-9a-f]{32}$/.test(key) ? await readOwnStatus(cfg.listen, key).catch(() => null) : null;
      const said = nextPayoutSentence(own?.nextPayout);
      if (said) console.log(`next payout: ${said.charAt(0).toLowerCase()}${said.slice(1)}`);
    };
    // The books day by day: what each UTC day billed and what it paid out to the wallet, a week unless --since says.
    // By month, the same days added up by UTC calendar month, a year unless --since says.
    if (flag('by') === 'day' || flag('by') === 'month') {
      const unit = flag('by') as 'day' | 'month';
      const window = has('since') ? since : unit === 'day' ? '7d' : '365d';
      const byDay = booksByDay(readTrips(log), readPayouts(`${expand(cfg.dataDir ?? home('provider'))}/payouts.jsonl`), windowMs(window), Date.now(), readDays(`${expand(cfg.dataDir ?? home('provider'))}/days.jsonl`));
      const days = unit === 'day' ? byDay : booksByMonth(byDay);
      // The rows alone, for a spreadsheet: nothing else is printed, so it can go straight to a file.
      if (has('csv')) return console.log(booksByDayCsv(days, unit));
      // The same books for a script, with what the chain says has landed.
      if (has('json')) {
        const row = (r: { day: string; answers: number; billed: bigint; payouts: number; paid: bigint }) => ({ [unit]: r.day, answers: r.answers, billed: usd(r.billed), payouts: r.payouts, paidOut: usd(r.paid) });
        return console.log(JSON.stringify({ since: window, by: unit, rows: days.rows.map(row), total: { answers: days.total.answers, billed: usd(days.total.billed), payouts: days.total.payouts, paidOut: usd(days.total.paid) }, onChain: await onChain() }, null, 2));
      }
      if (!days.rows.length) console.log(`Nothing served or paid out in the last ${window}. The node logs each answer to ${log}.`);
      else console.log([`"${cfg.name}", last ${window}, by ${unit} (UTC): billed from its log of answers, paid out from the payouts it keeps`, ...booksByDayLines(days, unit)].join('\n'));
      await landed();
      return nextOut();
    }
    // Everything this command says, for a script: the rows, the answers at the holder price, what reached the wallet in
    // the window, how routers paid, and what the chain says has landed.
    if (has('json')) {
      const served = readTrips(log);
      const out = readPayouts(payoutsPath).filter((p) => Date.now() - p.at <= windowMs(since)).sort((a, b) => b.at - a.at);
      const held = heldSaved(served, windowMs(since));
      return console.log(JSON.stringify({
        since, by: label,
        rows: rows.map((r) => ({ key: r.key, answers: r.answers, inputTokens: r.inputTokens, outputTokens: r.outputTokens, billed: usd(r.units) })),
        total: { answers: total.answers, inputTokens: total.inputTokens, outputTokens: total.outputTokens, billed: usd(total.units) },
        holders: { answers: held.answers, underList: usd(held.units), off: held.offs },
        paidOut: { payouts: out.length, usd: usd(out.reduce((a, p) => a + BigInt(p.units), 0n)), lastTx: out[0]?.tx ?? null },
        paidInside: paidInside(served, windowMs(since)),
        onChain: await onChain(),
      }, null, 2));
    }
    if (!total.answers) {
      console.log(`No answers served in the last ${since}. The node logs each answer to ${log}.`);
      await landed();
      return nextOut();
    }
    console.log(`"${cfg.name}", last ${since}, by ${label} (billed; routers sign the lower of the bill and their own math)`);
    // What reached the wallet in the same window, from the payouts this node keeps beside its log.
    const paidOut = paidOutLine(readPayouts(`${expand(cfg.dataDir ?? home('provider'))}/payouts.jsonl`), windowMs(since), since);
    // An image model's row says how many pictures it sold and what each came to, from its 1,000 output tokens an image.
    const isImageRow = (key: string) => (byKind ? key === 'image' : by === 'model' && cfg.models.find((m) => m.id === key)?.kind === 'image');
    const imagesNote = (r: { key: string; outputTokens: number; units: bigint }) => {
      const n = isImageRow(r.key) ? Math.floor(r.outputTokens / IMAGE_TOKENS) : 0;
      return n ? `  (${n.toLocaleString('en-US')} image${n === 1 ? '' : 's'}, $${usd(r.units / BigInt(n))} each)` : '';
    };
    for (const r of [...rows, total]) console.log(`${r.key.padEnd(24)} ${String(r.answers).padStart(7)} ${r.answers === 1 ? 'answer ' : 'answers'}  ${r.inputTokens.toLocaleString('en-US').padStart(10)} in  ${r.outputTokens.toLocaleString('en-US').padStart(9)} out  ${`$${usd(r.units)}`.padStart(11)}${r === total ? '' : imagesNote(r)}`);
    // How many of these answers went at the holder price, and what that came to below the list prices.
    const given = heldGivenLine(heldSaved(readTrips(log), windowMs(since)), total.answers);
    if (given) console.log(given);
    if (paidOut) console.log(paidOut);
    await landed();
    await nextOut();
    // How routers paid: inside the seal, or with the channel named in headers this node's host can read.
    const paid = paidInside(readTrips(log), windowMs(since));
    console.log(`paid inside the seal: ${paid.inside} of ${paid.answers} answer${paid.answers === 1 ? '' : 's'}${paid.inside < paid.answers ? '; the rest named their channel in headers your host can read (routers before 0.1.16)' : ''}`);
    return;
  }
  const node = new ProviderNode(cfg);
  // Each payout this node kept, next to what the chain's record of its transaction says reached the wallet: the books
  // checked against the chain, one transaction lookup per payout shown.
  if (sub === 'payouts') {
    const kept = readPayouts(`${node.dir}/payouts.jsonl`).sort((a, b) => b.at - a.at);
    const last = Math.min(50, Math.max(1, Math.floor(Number(flag('last', '5')) || 5)));
    const shown = kept.slice(0, last);
    const wallet = node.authority.toBase58(), mint = node.mint.toBase58();
    const rows = await checkPayouts(node.conn, shown, wallet, mint);
    if (has('csv')) return console.log(payoutsCsv(rows));
    if (has('json')) return console.log(JSON.stringify({ name: cfg.name, wallet, kept: kept.length, payouts: rows.map(({ p, chain }) => ({ ...p, chain: chain ? { state: chain.state, units: chain.state === 'landed' ? chain.units.toString() : null } : null })) }, null, 2));
    const lines = payoutCheckLines(cfg.name, rows, kept.length);
    if (rows.some((r) => r.chain && !(r.chain.state === 'landed' && r.chain.units === BigInt(r.p.units)))) process.exitCode = 1;
    return console.log(lines.join('\n'));
  }
  // Every voucher this node holds, checked against its channel on chain the way the program checks a redeem: one read
  // of all the channels, no transaction, nothing paid.
  if (sub === 'vouchers') {
    const ledgerFile = `${node.dir}/ledger.json`;
    const ledger = existsSync(ledgerFile) ? (JSON.parse(readFileSync(ledgerFile, 'utf8')) as Record<string, { best?: string }>) : {};
    const addresses = Object.keys(ledger).filter((a) => ledger[a].best);
    const accounts = new Map<string, ChannelAccount | null>();
    for (let i = 0; i < addresses.length; i += 100) {
      const part = addresses.slice(i, i + 100);
      const infos = await node.conn.getMultipleAccountsInfo(part.map((a) => new PublicKey(a)));
      part.forEach((a, k) => accounts.set(a, infos[k] ? decodeChannel(infos[k]!.data) : null));
    }
    const rows = checkVouchers(ledger, accounts, node.pda);
    if (rows.some((r) => r.problem && r.signed !== null)) process.exitCode = 1;
    if (has('json')) return console.log(JSON.stringify({ name: cfg.name, vouchers: rows.map((r) => ({ channel: r.channel, signedFor: usd(r.cumulative), deposit: r.deposit === null ? null : usd(r.deposit), settled: r.settled === null ? null : usd(r.settled), signatureGood: r.signed, redeemable: usd(r.pays), closingAt: r.closingAt === null ? null : new Date(r.closingAt * 1000).toISOString(), problem: r.problem ?? null })), redeemable: usd(rows.reduce((a, r) => a + r.pays, 0n)) }, null, 2));
    return console.log(renderVouchers(cfg.name, rows));
  }
  // The console's address with its key, from this node's folder: for an operator whose start output is gone.
  if (sub === 'console') return console.log(`http://127.0.0.1:${cfg.listen}/?key=${node.consoleKey()}`);
  // What the console shows, in a terminal: for a node on a server with no browser. Read from the running node.
  if (sub === 'status') {
    const s = await readOwnStatus(cfg.listen, node.consoleKey());
    if (!s) {
      process.exitCode = 1;
      return console.log(`no node is answering on 127.0.0.1:${cfg.listen}. Start it with: ${CLI} provider start --config ${cfgPath}`);
    }
    const unsigned = s.channels.reduce((n, c) => n + c.unsigned, 0);
    // Where the listing stands on chain: a node edited and not listed again gets no routers and no error.
    const onChain = await node.conn.getAccountInfo(node.pda).then((i) => (i ? decodeProvider(i.data) : null)).catch(() => undefined);
    const listing = onChain === undefined ? null : listingState(onChain, { manifestHash: node.manifestHash, runningHash: s.manifestHash ? Buffer.from(s.manifestHash, 'hex') : null, publicUrl: cfg.publicUrl });
    // The last day from the node's own log of answers: a restart resets the count since start, not this.
    const day = await readOwnDay(cfg.listen, node.consoleKey());
    // And this UTC month so far, from the node's books: what it billed and what was paid out to the wallet.
    const month = await readOwnMonth(cfg.listen, node.consoleKey());
    // The fee money, before it is a problem: every payout is one transaction the node key pays for.
    const lamports = await node.conn.getBalance(node.node.publicKey).catch(() => null);
    // The first payout to a wallet with no USDC account opens it, at the key's cost: counted before the payouts.
    const openingRent = lamports === null ? null : await node.payoutAccountRent();
    const payoutsLeft = lamports === null ? null : Math.floor(Math.max(0, lamports - (openingRent ?? 0)) / REDEEM_FEE_LAMPORTS);
    // When it last answered: a node that stopped getting work shows it here before anywhere else.
    const lastAt = s.recent?.[0]?.at ?? null;
    const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);
    if (has('json')) return console.log(JSON.stringify({ name: s.name, provider: s.provider, answers: s.answers, signed: s.signed, redeemed: s.redeemed, waiting: s.waiting, payoutFailed: s.payoutFailed ?? null, listing, reach: s.reach ?? null, day: day ? { answers: day.answers, billed: day.usd, ...(day.kinds ? { kinds: day.kinds.map((k) => ({ kind: k.key, answers: k.answers, billed: k.usd })) } : {}) } : null, month: month ? { month: month.day, answers: month.answers, billed: month.billed, payouts: month.payouts, paidOut: month.paid } : null, payouts: s.payouts ?? null, wallet: s.wallet ? { held: usd(BigInt(s.wallet.units)), afterTx: s.wallet.tx, at: new Date(s.wallet.at).toISOString() } : null, notify: s.notify ? { host: s.notify.host, last: s.notify.last ? { at: new Date(s.notify.last.at).toISOString(), what: s.notify.last.what, status: s.notify.last.status } : null } : null, slots: s.slots ?? null, channels: s.channels.length, unsignedAnswers: unsigned, feeLamports: lamports, payoutsLeft, opensUsdcAccount: openingRent !== null, lastAnswerAt: lastAt === null ? null : new Date(lastAt).toISOString() }, null, 2));
    const fees = lamports === null ? 'the RPC did not answer' : feesLine({ lamports, openingRent, nodeKey: node.node.publicKey.toBase58() });
    return console.log([
      `${s.name}  ·  listing ${s.provider}`,
      ...(listing ? [listingLine(listing, { config: cfgPath, endpoint: onChain?.endpoint })] : []),
      `  answers since start   ${s.answers}`,
      ...(day ? [dayLine(day)] : []),
      ...(kindsLine(day?.kinds) ? [kindsLine(day?.kinds)!] : []),
      ...(month ? [monthLine(month)] : []),
      `  signed to you         $${s.signed}`,
      `  redeemed on chain     $${s.redeemed}`,
      `  waiting to redeem     $${s.waiting}${s.nextPayout ? nextPayoutHint(s.nextPayout, cfgPath) : payoutHint(s.waiting, cfg.redeem?.minUnits ?? REDEEM_MIN_UNITS, cfg.redeem?.everySecs ?? 60, cfgPath, !(await node.paidOutBefore()))}`,
      // When money last landed in the wallet, and what the last day came to: kept by the node, so a restart keeps it.
      ...(s.payoutFailed ? [`  ${payoutFailedSentence(s.payoutFailed)}`] : []),
      ...(s.payouts === undefined ? [] : payoutLines(s.payouts, Date.now(), !s.payouts && (await node.paidOutBefore()))),
      ...(s.wallet ? [walletLine(s.wallet)] : []),
      ...(s.notify ? [noticeLine(s.notify.host, s.notify.last)] : []),
      ...(s.slots ? [slotsLine(s.slots)] : []),
      `  channels            ${s.channels.length}${unsigned ? `  (${unsigned} answer${unsigned === 1 ? '' : 's'} not signed for yet)` : ''}`,
      `  last answer           ${lastAt === null ? 'none since start' : `${ago(Date.now() - lastAt)} ago (${new Date(lastAt).toISOString().slice(11, 19)} UTC)`}`,
      ...(s.reach ? [reachLine(s.reach, cfgPath)] : []),
      // What the model server turned away, from the node's own record of it: the log says each one as it happens.
      ...(s.refused ? [`  model server refused  ${refusedText(s.refused as Parameters<typeof refusedText>[0])}`] : []),
      `  fees                  ${fees}`,
    ].join('\n'));
  }
  if (cfg.burn) {
    // A pledge needs the wallet on this machine: the buy and the burn are the wallet's own transactions.
    if (!cfg.wallet && !flag('wallet')) throw new Error('a burn pledge needs the provider wallet on this machine ("wallet" in provider.json or --wallet): the buy and the burn are signed by it');
    const w = loadKeypair(expand(flag('wallet', cfg.wallet)!));
    const conn = rpcConnection(cfg.rpcUrl ?? rpc());
    const cfgInfo = await conn.getAccountInfo(pda.config());
    const token = cfgInfo ? decodeConfig(cfgInfo.data).bondMint : PublicKey.default;
    if (token.equals(PublicKey.default)) throw new Error('the network token is not set on this program yet, so there is nothing to buy and burn');
    const tokenInfo = await conn.getParsedAccountInfo(token);
    const decimals = (tokenInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals ?? 6;
    const tokenProgram = tokenInfo.value?.owner;
    node.burnHooks = { swap: jupiterSwapper(conn, w, new PublicKey(cfg.settleMint), token, { tokenProgram }), burn: splBurner(conn, w, token, decimals, tokenProgram) };
    if (sub === 'burn') {
      // orrery provider burn --config provider.json [--yes]: what the pledge owes now, and with --yes, buy and burn it.
      const acct = await conn.getAccountInfo(node.pda);
      const redeemed = acct ? decodeProvider(acct.data).settled : 0n;
      const book = loadBook(`${expand(cfg.dataDir ?? home('provider'))}/burns.json`);
      const due = burnDue(redeemed, cfg.burn.share, book.spent);
      console.log(`"${cfg.name}" pledged ${cfg.burn.share / 100}% of what it redeems`);
      console.log(`  redeemed on chain   $${usd(redeemed)}`);
      console.log(`  spent on burns      $${usd(book.spent)} in ${book.receipts.length} buy${book.receipts.length === 1 ? '' : 's'}`);
      console.log(`  due now             $${usd(due)}${due < BigInt(cfg.burn.minUnits ?? 10_000) ? `  (below the smallest buy, $${usd(BigInt(cfg.burn.minUnits ?? 10_000))}; it waits)` : ''}`);
      if (due > 0n) {
        const q = await jupQuote(cfg.settleMint, token.toBase58(), due).catch((e: Error) => e);
        console.log(q instanceof Error ? `  market              ${q.message}` : `  market              a route with ${q.routePlan.length} hop${q.routePlan.length === 1 ? '' : 's'} is open for that amount`);
      }
      if (!has('yes')) return console.log('  nothing was sent. Run again with --yes to buy and burn what is due.');
      const r = await node.burnDue();
      return console.log(r ? `  bought and burned ${r.burned} token units for $${usd(BigInt(r.usdc))}\n  buy  ${r.swapTx}\n  burn ${r.burnTx}` : '  nothing was burned.');
    }
  } else if (sub === 'burn') throw new Error('this provider.json has no "burn": { "share": … } pledge');
  if (sub === 'check') {
    const lines = await providerCheck(node);
    // The exit code says whether the node is ready, in either form: a monitor running --json reads it too.
    process.exitCode = lines.some((l) => l.ok === false) ? 1 : 0;
    if (has('json')) return console.log(JSON.stringify(lines, null, 2));
    console.log(renderCheck(cfg.name, lines));
    console.log(nextStep(lines, { config: cfgPath, publicUrl: cfg.publicUrl, nodeKey: node.node.publicKey.toBase58(), localCluster: privateAddress(node.conn.rpcEndpoint), firstPayout: !(await node.paidOutBefore()), everySecs: cfg.redeem?.everySecs ?? 60, ...walletWhere(cfg) }));
    return;
  }
  if (sub === 'start') {
    await node.listen();
    console.log(`${NAME} provider "${cfg.name}" on :${cfg.listen}  ·  listing ${node.pda.toBase58()}  ·  ${cfg.models.length} models  ·  manifest ${node.manifestHash.toString('hex').slice(0, 12)}…`);
    console.log(consoleLine(cfg.listen, node.consoleKey(), !!process.stdout.isTTY, cfgPath));
    // Once it is up, the one thing left before it earns: a node that is not listed yet would otherwise wait in silence.
    void providerCheck(node).then(async (lines) => console.log(nextStep(lines, { config: cfgPath, publicUrl: cfg.publicUrl, nodeKey: node.node.publicKey.toBase58(), running: true, localCluster: privateAddress(node.conn.rpcEndpoint), firstPayout: !(await node.paidOutBefore()), everySecs: cfg.redeem?.everySecs ?? 60, ...walletWhere(cfg) }))).catch(() => undefined);
    return;
  }
  if (sub === 'register') {
    const walletPath = expand(flag('wallet', cfg.wallet ?? '')!);
    if (!walletPath || !existsSync(walletPath)) throw new Error(walletPath ? `there is no keypair at ${walletPath}. Pass --wallet <keypair.json>: the wallet this node is listed under signs this one transaction` : 'pass --wallet <keypair.json>: the wallet this node is listed under signs this one transaction');
    const w = loadKeypair(walletPath);
    if (!w.publicKey.equals(node.authority)) throw new Error('the wallet does not match the config authority');
    // --fund-key [sol]: the same transaction sends the node's key its fee money, so a new operator funds one address.
    const fundAt = argv.indexOf('--fund-key');
    const fund = fundAt < 0 ? 0 : fundKeyLamports(argv[fundAt + 1] && !argv[fundAt + 1].startsWith('--') ? argv[fundAt + 1] : undefined);
    const exists = await node.conn.getAccountInfo(node.pda);
    // Nothing is sent when it cannot work or would be wasted: the wallet cannot pay, or the address is the placeholder.
    const problem = registerProblem({ publicUrl: cfg.publicUrl, exists: !!exists, lamports: await node.conn.getBalance(w.publicKey), rent: exists ? 0 : await node.conn.getMinimumBalanceForRentExemption(LISTING_BYTES), wallet: w.publicKey.toBase58(), fund, localCluster: privateAddress(node.conn.rpcEndpoint), privateOk: has('private-address') });
    if (problem) throw new Error(problem);
    const ix = exists ? node.updateInstruction(w.publicKey) : node.registerInstruction(w.publicKey);
    const tx = new Transaction().add(ix);
    if (fund) tx.add(SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: node.node.publicKey, lamports: fund }));
    const sig = await sendOne(node.conn, tx, [w]);
    console.log(`${exists ? 'updated' : 'listed'} ${node.pda.toBase58()}  tx ${sig}`);
    if (fund) {
      const opens = (await node.conn.getAccountInfo(pda.ata(w.publicKey, node.mint)).catch(() => undefined)) === null ? await node.conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES).catch(() => null) : null;
      console.log(fundKeyNote(fund, node.node.publicKey.toBase58(), opens));
    }
    console.log(`next: ${CLI} provider check --config ${cfgPath} says what is left before it earns`);
    return;
  }
  if (sub === 'attest') {
    const sig = await sendOne(node.conn, new Transaction().add(node.attestInstruction()), [node.node]);
    console.log(`enclave claim posted  tx ${sig}`);
    return;
  }
  if (sub === 'redeem') {
    const done = await node.redeemDue(1n);
    console.log(done.length ? done.map((d) => `$${usd(d.amount)} from ${d.channel}`).join('\n') : 'nothing to redeem');
    return;
  }
  if (sub === 'show') {
    const info = await node.conn.getAccountInfo(node.pda);
    if (!info) return console.log('not listed');
    const p = decodeProvider(info.data);
    console.log({ ...p, authority: p.authority.toBase58(), nodeKey: p.nodeKey.toBase58() });
    return;
  }
  throw new Error(`unknown provider command ${sub}`);
}

async function main() {
  const [cmd, sub] = argv;
  // After `--` the arguments are the client's (orrery run claude -- --help asks Claude Code, not this CLI).
  const ownArgs = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  if (!cmd || cmd === 'help' || ownArgs.includes('--help')) return console.log(HELP);
  // --proxy (or ORRERY_PROXY) sends every request this command makes to a node or to the RPC through that proxy,
  // never around it.
  const proxyAt = ownArgs.indexOf('--proxy');
  const proxyText = proxyAt >= 0 ? ownArgs[proxyAt + 1] : process.env.ORRERY_PROXY;
  // A privacy flag that was typed without its address must stop here, not run without a proxy.
  if (proxyAt >= 0 && (!proxyText || proxyText.startsWith('--'))) throw new Error('--proxy needs an address, e.g. --proxy http://127.0.0.1:8118 or --proxy socks5://127.0.0.1:9050');
  if (proxyText) setNodeProxy(parseProxy(proxyText));
  if (cmd === 'provider' && sub === 'init') {
    const out = flag('out', 'provider.json')!;
    if (existsSync(out) && !has('force')) throw new Error(`${out} exists; pass --force to replace it`);
    // A webhook for payout notices, checked before anything is written: an address, or the variable that holds one.
    const notify = flag('notify') ? { url: notifyUrl({ url: flag('notify') })! } : flag('notify-env') ? { urlEnv: flag('notify-env')! } : undefined;
    const found = await findUpstream(flag('upstream'));
    // The wallet the draft names is one the operator has, or the place `orrery wallet new` will put one.
    const homeWallet = home('wallet.json');
    const cfg = draftConfig(found, { name: flag('name'), publicUrl: flag('public-url'), rpcUrl: flag('rpc', process.env.ORRERY_RPC_URL), wallet: draftWallet({ asked: flag('wallet'), home: homeWallet, homeExists: existsSync(homeWallet), solanaExists: existsSync(expand(SOLANA_WALLET)) }), notify, holderPrices: !has('no-holder-prices') });
    writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`);
    console.log(`found ${found.name} at ${found.baseUrl} with ${found.models.length} model${found.models.length === 1 ? '' : 's'}: ${found.models.slice(0, 6).join(', ')}${found.models.length > 6 ? ', …' : ''}`);
    const emb = found.models.filter(isEmbeddingModel);
    if (emb.length) console.log(`${emb.join(', ')} ${emb.length === 1 ? 'is an embedding model' : 'are embedding models'}: listed for /v1/embeddings, priced on input tokens only ($0.02 per million to start)`);
    const rer = found.models.filter(isRerankModel);
    if (rer.length) console.log(`${rer.join(', ')} ${rer.length === 1 ? 'is a reranker' : 'are rerankers'}: listed for /v1/rerank, priced on input tokens only ($0.02 per million to start); your model server answers /rerank`);
    const painters = found.models.filter(isImageModel);
    if (painters.length) console.log(`${painters.join(', ')} ${painters.length === 1 ? 'is an image model' : 'are image models'}: listed for /v1/images/generations, each image billed as 1,000 output tokens ($0.003 an image to start); your model server answers /images/generations`);
    const voices = found.models.filter(isSpeechModel);
    if (voices.length) console.log(`${voices.join(', ')} ${voices.length === 1 ? 'is a speech model' : 'are speech models'}: listed for /v1/audio/speech, billed on the text at one input token per 4 characters ($2 per million tokens to start); your model server answers /audio/speech`);
    if (found.name === 'Ollama' && found.models.some((m) => !isEmbeddingModel(m))) console.log(OLLAMA_NOTE);
    if (CACHE_REPORTING[found.name]) console.log(`each model also has a cached-input price (a quarter of input) for prompt-cache hits; start ${found.name} with ${CACHE_REPORTING[found.name]} so it reports them`);
    // Where the draft prices would stand against what is already listed, so the first edit is an informed one.
    if (!has('offline')) {
      const registry = new Registry(rpcConnection(rpc()), { allowDev: false, measurements: [] });
      const listed = await registry.refresh().then(() => registry.usable()).catch(() => null);
      if (listed) console.log(`\n${renderCompare(cfg.name, compare(cfg.models.map((m) => ({ id: m.id, price: m.price, kind: m.kind })), listed, null))}\n`);
    }
    // Holder prices are written in unless the operator left them out; say what they are and how to drop them.
    if (cfg.holder) console.log(`${holderTiersNote(cfg.holder.tiers)} (the seed node's tiers; --no-holder-prices leaves them out, or edit "holder" in ${out})`);
    if (notify) console.log(`payout notices: each payout's arrival, and the day's books just after midnight UTC, go to ${notify.url ? new URL(notify.url).host : `the webhook in ${notify.urlEnv}`}; ${CLI} provider check sends a test one`);
    console.log(`wrote ${out}. Next:\n${nextSteps(out, CLI, { publicUrl: cfg.publicUrl, localCluster: privateAddress(cfg.rpcUrl) })}`);
    const walletFile = expand(cfg.wallet);
    const listedUnder = existsSync(walletFile) ? (() => { try { return loadKeypair(walletFile).publicKey.toBase58(); } catch { return undefined; } })() : undefined;
    console.log(walletNote({ wallet: cfg.wallet, exists: existsSync(walletFile), isHome: cfg.wallet === homeWallet, out, address: listedUnder }, CLI));
    return;
  }
  if (cmd === 'connect') {
    if (!sub || !(CLIENTS as readonly string[]).includes(sub)) throw new Error(`usage: ${CLI} connect <${CLIENTS.join('|')}> [--model <id>] [--agent <name>] [--write]`);
    const agent = flag('agent') || null;
    if (agent && !AgentBook.valid(agent)) throw new Error('--agent takes a name of letters, digits and ._:- up to 64 characters, e.g. --agent coder');
    const routerUrl = flag('router', `http://127.0.0.1:${ROUTER_PORT}`)!;
    // The settings are only worth printing if the router they point at will serve them: is one answering, and does
    // it list the model? With no --model, a model it does list is named.
    const listed = await routerModels(routerUrl);
    const model = flag('model') ?? (listed ? pickModel(listed) : undefined) ?? USUAL_MODEL;
    const note = routerNote({ client: sub as Client, router: routerUrl, models: listed, model, asked: !!flag('model'), hasWallet: !!walletFlag() });
    const profilePath = `${expand(process.env.CODEX_HOME ?? '~/.codex')}/orrery.config.toml`;
    if (!has('write')) return console.log(instructions(sub as Client, routerUrl, model, profilePath, agent) + (note ? `\n${note}` : ''));
    if (sub !== 'codex') throw new Error('--write is for codex; the others take environment variables');
    if (existsSync(profilePath) && !has('force')) throw new Error(`${profilePath} exists; pass --force to replace it`);
    mkdirSync(dirname(profilePath), { recursive: true });
    const ctx = await contextFromRouter(routerUrl, model);
    writeFileSync(profilePath, codexProfile(routerUrl, model, ctx, agent));
    return console.log(`wrote ${profilePath}${ctx ? ` (context window ${ctx}, from your router)` : ''}\nrun: codex --profile orrery${note ? `\n${note}` : ''}`);
  }
  if (cmd === 'run') {
    // orrery run claude [--budget <usd>] [--task <name>] [--model <id>] [--router <url>] [-- <the client's own arguments>]
    // orrery run [--budget <usd>] [--task <name>] [--router <url>] -- <any command and its arguments>
    const cut = argv.indexOf('--');
    const mine = cut >= 0 ? argv.slice(0, cut) : argv;
    const rest = cut >= 0 ? argv.slice(cut + 1) : [];
    const own = (name: string, fallback?: string) => { const i = mine.indexOf(`--${name}`); return i >= 0 ? mine[i + 1] : fallback; };
    const client = mine[1] && !mine[1].startsWith('--') ? mine[1] : null;
    if ((client && !(RUNNABLE as readonly string[]).includes(client)) || (!client && !rest.length)) throw new Error(`usage: ${CLI} run <${RUNNABLE.join('|')}> [--budget <usd>] [--task <name>] [--model <id>] [--router <url>] [-- <its own arguments>]\n       ${CLI} run [--budget <usd>] [--task <name>] [--router <url>] -- <any command>`);
    const routerUrl = own('router', process.env.ORRERY_ROUTER_URL ?? `http://127.0.0.1:${ROUTER_PORT}`)!;
    const models = await routerModels(routerUrl);
    if (!models) throw new Error(`no router answers at ${routerUrl}; start one first: ${startRouter(!!walletFlag())}`);
    const model = own('model') ?? (client ? pickModel(models) : undefined);
    if (client && !model) throw new Error(`the router lists no model yet; see ${CLI} models`);
    // A job needs a budget from its first request, so one is always set: a dollar unless you say otherwise.
    const budget = own('budget') ?? '1';
    if (!(Number(budget) > 0)) throw new Error('--budget is a dollar amount such as 0.25');
    const task = own('task') ?? taskName(client ?? (rest[0].split('/').pop() || 'job'), process.cwd());
    if (!/^[A-Za-z0-9._:\-]{1,64}$/.test(task)) throw new Error('--task: letters, digits, . _ : - (at most 64)');
    const p = client
      ? plan(client as Runnable, { router: routerUrl, task, budget, model: model!, args: rest, env: process.env })
      : planCommand({ router: routerUrl, task, budget, command: rest[0], args: rest.slice(1), env: process.env });
    const listed = models.map((m) => m.id).filter(Boolean).slice(0, 4).join(', ');
    console.error(`${CLI} · ${task} · ${client ? model : `models: ${listed || 'none listed'}`} · budget $${budget}${own('budget') ? '' : ' (default; --budget changes it)'} · ${routerUrl}`);
    const code = await new Promise<number>((done) => {
      const child = spawn(p.command, p.args, { stdio: 'inherit', env: p.env });
      // Ctrl-C belongs to the client; this process waits for it to finish and then prints the bill.
      process.on('SIGINT', () => {});
      child.on('error', (e: NodeJS.ErrnoException) => { console.error(e.code === 'ENOENT' ? `${p.command} is not installed, or not on PATH` : e.message); done(127); });
      child.on('exit', (c, sig) => done(c ?? (sig ? 130 : 1)));
    });
    console.error(`\n${renderBill(await readBill(routerUrl, task), task)}`);
    process.exit(code);
  }
  if (cmd === 'bench') {
    if (!sub) throw new Error(`usage: ${CLI} bench <model> [--n 3] [--router <url>]`);
    const registry = new Registry(rpcConnection(rpc()), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    const providers = registry.usable().filter((e) => e.manifest!.models.some((m) => m.id === sub));
    if (!providers.length) throw new Error(`no provider on the network lists ${sub}; see ${CLI} models`);
    const rows = await bench({ model: sub, providers, router: flag('router', `http://127.0.0.1:${ROUTER_PORT}`)!, n: Math.max(1, Math.min(20, Number(flag('n', '3')))) });
    if (has('json')) return console.log(JSON.stringify({ model: sub, providers: rows.map((r) => ({ name: r.name, address: r.address, asked: r.asked, answered: r.answered, ttftMsMedian: median(r.ttftMs) || null, totalMsMedian: median(r.totalMs) || null, perAnswer: r.units.length ? usd(r.units.reduce((a, b) => a + b, 0n) / BigInt(r.units.length)) : null, listed: r.price, error: r.error ?? null })) }, null, 2));
    return console.log(renderBench(sub, rows));
  }
  if (cmd === 'sealed') {
    // orrery sealed [--since 30d] [--json]: every private answer this router paid for, and what it had verified.
    const since = flag('since', '30d')!;
    const rows = sealedTrips(readTrips(home('router', 'trips.jsonl')), windowMs(since));
    if (has('json')) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log(`No sealed answers in the last ${since}. Add :private to a model name to ask only nodes whose enclave this router verified.`);
    console.log(`sealed answers, last ${since} · what this router verified before it encrypted each prompt`);
    for (const t of rows) console.log(`${new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')}  ${t.model.slice(0, 22).padEnd(23)}${t.providerName.slice(0, 20).padEnd(21)}${(t.enclave?.kind ?? 'enclave').padEnd(23)}image ${(t.enclave?.image ?? '').slice(0, 16)}…  ${t.enclave?.verdict ?? ''}`);
    return;
  }
  if (cmd === 'spend') {
    const byFlag = flag('by', 'model');
    const by = byFlag === 'provider' || byFlag === 'task' || byFlag === 'day' || byFlag === 'agent' || byFlag === 'kind' ? byFlag : 'model';
    // By day it is your books of what the router paid, a week unless --since says otherwise.
    const since = flag('since', by === 'day' ? '7d' : '24h')!;
    const spendTrips = readTrips(home('router', 'trips.jsonl'));
    const { rows, total } = summarize(spendTrips, by, windowMs(since));
    // The rows alone, for a spreadsheet or an expense report: nothing else is printed, so it can go straight to a file.
    if (has('csv')) return console.log(spendCsv(rows, by));
    // Answers that came from the next node after another did not answer: that node was signed nothing.
    const skips = skipped(spendTrips, windowMs(since));
    // Requests no node answered: nothing was signed for them, and the router keeps them apart from the answers.
    const unanswered = unansweredIn(readUnanswered(home('router', 'unanswered.jsonl')), windowMs(since));
    // What holding the network token took off these answers, at the nodes that priced them for holders.
    const held = heldSaved(spendTrips, windowMs(since));
    if (has('json')) return console.log(JSON.stringify({ since, by, rows: [...rows, total].map((r) => ({ key: r.key, answers: r.answers, inputTokens: r.inputTokens, outputTokens: r.outputTokens, usd: usd(r.units), cacheKept: r.cacheKept })), afterANodeDidNotAnswer: { answers: skips.answers, nodes: skips.nodes }, finishedByAnotherNode: skips.resumed, held: { answers: held.answers, usd: usd(held.units), off: held.offs } }, null, 2));
    if (!total.answers) return console.log(`No answers in the last ${since}. The router logs each answer it pays for to ${home('router', 'trips.jsonl')}.${unanswered.requests ? ` ${unansweredNote(unanswered)}` : ''}`);
    const line = (r: { key: string; answers: number; inputTokens: number; outputTokens: number; units: bigint; cacheKept: number }) => `${r.key.padEnd(26)} ${String(r.answers).padStart(7)} ${r.answers === 1 ? 'answer ' : 'answers'}  ${r.inputTokens.toLocaleString('en-US').padStart(10)} in  ${r.outputTokens.toLocaleString('en-US').padStart(9)} out  ${`$${usd(r.units)}`.padStart(11)}${r.cacheKept ? `  ${r.cacheKept} kept for cache` : ''}`;
    console.log(`last ${since}, by ${by}`);
    for (const r of rows) console.log(line(r));
    console.log(line(total));
    // Your books by day end with the month so far, whatever the window.
    if (by === 'day') console.log(spentMonthLine(spentThisMonth(spendTrips)));
    if (held.answers) console.log(heldSavedLine(held));
    if (skips.answers || skips.resumed) console.log(skipNote(skips));
    if (unanswered.requests) console.log(unansweredNote(unanswered));
    return;
  }
  if (cmd === 'doctor') {
    const walletPath = walletFlag();
    const address = flag('address');
    const sessionPath = home('router', 'session.json');
    const lines = await doctor({ routerHome: home('router'), walletFile: !address && !!walletPath && existsSync(expand(walletPath)), rpc: rpc(), mint: mint(), session: existsSync(sessionPath) ? loadKeypair(sessionPath).publicKey : undefined, wallet: address ? new PublicKey(address) : walletPath ? loadKeypair(expand(walletPath)).publicKey : undefined, router: flag('router', `http://127.0.0.1:${ROUTER_PORT}`)!, deposit: dollars(flag('deposit', '2')!), allowDev: has('allow-dev-enclaves'), version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, pins: home('router', 'pins.json') });
    console.log(has('json') ? JSON.stringify(lines.map((l) => ({ ...l, what: l.what.trim() })), null, 2) : render(lines));
    if (lines.some((l) => l.ok === false)) process.exitCode = 1;
    return;
  }
  if (cmd === 'wallet') {
    // A wallet file for someone who has none; only its address is ever printed.
    if (sub === 'new') {
      const out = resolvePath(expand(flag('out', home('wallet.json'))!));
      const { address } = newWallet(out);
      return console.log(walletNextSteps(out, address, flag('deposit', '2')!, CLI, out === resolvePath(home('wallet.json')) && !process.env.ORRERY_WALLET));
    }
    if (sub === 'address') {
      const path = expand(flag('wallet', process.env.ORRERY_WALLET ?? home('wallet.json'))!);
      if (!existsSync(path)) throw new Error(`there is no wallet at ${path}. ${CLI} wallet new makes one`);
      return console.log(loadKeypair(path).publicKey.toBase58());
    }
    throw new Error(`usage: ${CLI} wallet new [--out <file>]   or   ${CLI} wallet address [--wallet <file>]`);
  }
  if (cmd === 'router') return router();
  if (cmd === 'mcp') {
    const agent = flag('agent', process.env.ORRERY_AGENT) || null;
    if (agent && !AgentBook.valid(agent)) throw new Error('--agent takes a name of letters, digits and ._:- up to 64 characters, e.g. --agent researcher');
    return serveMcp(flag('router', process.env.ORRERY_ROUTER_URL ?? `http://127.0.0.1:${ROUTER_PORT}`)!, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, undefined, agent);
  }
  if (cmd === 'models') return listModels();
  if (cmd === 'quote') {
    const model = sub;
    if (!model) throw new Error(`usage: ${CLI} quote <model> [--in 2000 | --prompt "..." | --text "..."] [--out 500 | --images 1] [--cached 0.8] [--json]`);
    const registry = new Registry(rpcConnection(rpc()), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    // A model listed for embeddings, reranking or speech has no output to price; speech is billed on its text, so the
    // text to speak (--text, or --prompt) is counted the way a node bills it, one input token per 4 characters.
    const kind = quoteKind(registry.usable(), model);
    const prompt = flag('text') ?? flag('prompt');
    const images = kind === 'image' ? imageCount({ n: flag('images', '1') }) : 0;
    const inTokens = prompt ? (kind === 'speech' || kind === 'image' ? speechTokens(prompt) : estimateInputTokens({ messages: [{ role: 'user', content: prompt }] })) : Number(flag('in', kind === 'image' ? '50' : '2000'));
    const outTokens = kind === 'chat' ? Number(flag('out', '500')) : images * IMAGE_TOKENS;
    const cachedShare = Math.max(0, Math.min(1, Number(flag('cached', '0.8'))));
    const rows = quote(registry.usable(), model, inTokens, outTokens, cachedShare);
    // What this computer's router saw of each node, from the records it keeps in its home: no request is made for it.
    const watched = loadWatched(home('router', 'watched.json'));
    const seen = new Stats(home('router', 'observed.json'));
    const billsBy = new Map(bills(readTrips(home('router', 'trips.jsonl')), 86_400_000).map((x) => [x.provider, x]));
    const saw = (address: string) => sawText(watched.get(address), seen.all().get(address), Date.now(), billsBy.get(address));
    if (has('json')) return console.log(JSON.stringify({ model, ...(kind === 'chat' ? {} : { kind }), ...(kind === 'speech' && prompt ? { chars: prompt.length } : {}), ...(images ? { images } : {}), inTokens, outTokens, cachedShare, rows: rows.map((r) => ({ ...r, full: usd(r.full), cached: r.cached === null ? null : usd(r.cached), saw: saw(r.address) || null })) }, null, 2));
    return console.log(renderQuote(model, inTokens, outTokens, cachedShare, rows, saw, { kind, ...(kind === 'speech' && prompt ? { chars: prompt.length } : {}), ...(images ? { images } : {}) }));
  }
  if (cmd === 'enclave') {
    // orrery enclave verify: every check a router runs before it seals a prompt, one line each, on your own machine.
    //   --node <listing>            a node on the network: its claim from chain, its report from the node itself
    //   --report <f> --vcek <f>     an AMD SEV-SNP report and the chip's certificate
    //   --quote <f>                 an Intel TDX quote
    const reportPath = flag('report'), vcekPath = flag('vcek'), quotePath = flag('quote'), nodeAddr = flag('node');
    if (argv[1] !== 'verify' || !(nodeAddr || quotePath || (reportPath && vcekPath))) throw new Error('usage: orrery enclave verify --node <listing address> | --report <report.bin> --vcek <vcek.der> | --quote <tdx-quote.dat>  [--measurement <hex>] [--key <hex>] [--allow-debug] [--allow-outdated] [--min-firmware <b.t.s.m>] [--offline]');
    const want = (own: Buffer, name: string) => (flag(name) ? Buffer.from(flag(name)!, 'hex') : Buffer.from(own));
    // --min-firmware 3.0.8.115: refuse an AMD chip below this level (boot loader . trusted OS . SNP . microcode).
    const minFirmware = flag('min-firmware') ? parseFirmware(flag('min-firmware')!) : null;
    if (flag('min-firmware') && !minFirmware) throw new Error('--min-firmware is four numbers: <boot loader>.<tee>.<snp>.<microcode>, e.g. 3.0.8.115');
    if (nodeAddr) {
      const info = await rpcConnection(rpc()).getAccountInfo(new PublicKey(nodeAddr));
      if (!info) throw new Error(`no listing at ${nodeAddr}; orrery providers prints every listing's address`);
      const p = decodeProvider(info.data);
      const crls = has('offline') || (p.teeKind !== 1 && p.teeKind !== 2) ? undefined : await fetchCrls(p.teeKind === 2 ? 'amd' : 'intel', home('crl'));
      const audit = await auditEnclave(p, { allowDebug: has('allow-debug'), crls, minFirmware, allowOutdated: has('allow-outdated'), ...(has('offline') ? {} : { tcbFor: (fmspc: string) => fetchTcbInfo(fmspc, home('tcb')) }) });
      if (has('json')) console.log(JSON.stringify(audit, null, 2));
      else {
        console.log(`${nodeAddr} · ${p.endpoint}`);
        console.log(renderChecks(audit.checks) || '· this node does not claim an enclave');
        console.log(audit.ok ? `\n${audit.reason}.` : `\nNot verified: ${audit.reason}. A router sends this node no private prompts.`);
        if (audit.checks.length) console.log('Checked on this computer against the chip maker’s roots; no attestation service was asked.');
      }
      process.exitCode = audit.ok ? 0 : 1;
      return;
    }
    // The chip maker's revocation lists are read too, unless --offline: fetched from AMD or Intel, kept in ~/.orrery/crl.
    const crls = has('offline') ? undefined : await fetchCrls(quotePath ? 'intel' : 'amd', home('crl'));
    const v = quotePath
      ? await (async () => { const quote = readFileSync(expand(quotePath)); const q = parseTdxQuote(quote); return verifyTdx({ quote, measurement: want(q.mrtd, 'measurement'), enclaveKey: want(q.reportData.subarray(0, 32), 'key'), allowDebug: has('allow-debug'), crls, allowOutdated: has('allow-outdated'), ...(has('offline') ? {} : { tcb: await fetchTcbInfo(tdxFmspc(quote) ?? '', home('tcb')) }) }); })()
      : (() => { const report = readFileSync(expand(reportPath!)); const r = parseSnpReport(report); return verifySnp({ report, vcek: readFileSync(expand(vcekPath!)), measurement: want(r.measurement, 'measurement'), enclaveKey: want(r.reportData.subarray(0, 32), 'key'), allowDebug: has('allow-debug'), crls, minFirmware }); })();
    if (has('json')) console.log(JSON.stringify({ ok: v.ok, reason: v.reason, checks: v.checks ?? [] }, null, 2));
    else {
      console.log(v.checks?.length ? renderChecks(v.checks) : `✗ ${v.reason}`);
      console.log(v.ok ? `\n${v.reason}.` : `\nNot verified: ${v.reason}.`);
      if (!flag('measurement')) console.log('The image is taken from the report itself; pass --measurement <hex> to require the one you expect.');
      console.log(`Checked on this computer with ${quotePath ? 'Intel’s public root' : 'AMD’s public roots'}${crls ? ' and revocation list' : ''}; no attestation service was asked.`);
    }
    process.exitCode = v.ok ? 0 : 1;
    return;
  }
  if (cmd === 'providers') return listProviders();
  if (cmd === 'provider') return provider(sub ?? 'start');
  if (cmd === 'channels') return listChannels();
  if (cmd === 'close') {
    const walletPath = walletFlag();
    if (!sub || !walletPath) throw new Error(`usage: ${CLI} close <channel> --wallet <keypair.json> [--finish]`);
    const w = loadKeypair(expand(walletPath));
    const ch = new PublicKey(sub);
    const conn = rpcConnection(rpc());
    const info = await conn.getAccountInfo(ch);
    if (!info) return console.log(`${ch.toBase58()} is already closed`);
    const c = decodeChannel(info.data);
    if (!c.payer.equals(w.publicKey)) throw new Error('this wallet did not open that channel');
    if (!has('finish')) {
      if (c.closingAt !== 0n) return console.log(`already closing; the rest can come back after ${new Date(Number(c.closingAt) * 1000).toISOString()} with --finish`);
      await sendOne(conn, new Transaction().add(ins.requestClose(w.publicKey, ch)), [w]);
      const cfg = decodeConfig((await conn.getAccountInfo(pda.config()))!.data);
      return console.log(`closing ${ch.toBase58()}; the provider has ${cfg.closeGraceSecs}s to redeem, then run: ${CLI} close ${ch.toBase58()} --wallet ${walletPath} --finish`);
    }
    if (c.closingAt === 0n) throw new Error(`start the close first: ${CLI} close ${ch.toBase58()} --wallet ${walletPath}`);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < c.closingAt) throw new Error(`the grace period ends at ${new Date(Number(c.closingAt) * 1000).toISOString()}`);
    const prov = decodeProvider((await conn.getAccountInfo(c.provider))!.data);
    const sig = await sendOne(conn, new Transaction().add(ins.closeChannel(w.publicKey, prov.authority, ch, w.publicKey, c.mint)), [w]);
    return console.log(`closed ${ch.toBase58()}; $${usd(c.deposit - c.redeemed)} and the account rent are back in your wallet  tx ${sig}`);
  }
  console.log(HELP);
  process.exitCode = 1;
}

void pda;
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
