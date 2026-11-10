#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CLI, NAME, PROVIDER_PORT, ROUTER_PORT, USDC_MAINNET } from './brand.ts';
import { ACCOUNT, decodeChannel, decodeConfig, decodeProvider, ins, pda, programId } from './chain/program.ts';
import { home, loadKeypair, loadOrCreateKeypair } from './keys.ts';
import { HolderBook, sharePct, type HolderTier } from './holder.ts';
import { estimateInputTokens, perMillion, usd } from './pricing.ts';
import { ProviderNode, type ProviderConfig } from './provider/node.ts';
import { Channels } from './router/channels.ts';
import { parseAliases, parseCeiling, ROUTES, type Route } from './router/policy.ts';
import { Registry } from './router/registry.ts';
import { Router } from './router/server.ts';
import { serveMcp } from './mcp.ts';
import { CACHE_REPORTING, draftConfig, findUpstream, isEmbeddingModel } from './provider/init.ts';
import { CLIENTS, codexProfile, contextFromRouter, instructions, type Client } from './connect.ts';
import { doctor, render } from './doctor.ts';
import { readTrips, summarize, windowMs } from './spend.ts';
import { bench, median, renderBench } from './bench.ts';
import { quote, renderQuote } from './quote.ts';
import { compare, renderCompare } from './provider/compare.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);
const expand = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
const rpc = () => flag('rpc', process.env.ORRERY_RPC_URL ?? 'https://api.mainnet-beta.solana.com')!;
const mint = () => new PublicKey(flag('mint', process.env.ORRERY_SETTLE_MINT ?? USDC_MAINNET)!);
const dollars = (s: string) => BigInt(Math.round(Number(s) * 1e6));

const HELP = `${NAME} — peer-to-peer AI inference, settled on Solana

  ${CLI} router                 run the router on http://127.0.0.1:${ROUTER_PORT}/v1
      --wallet <keypair.json>   wallet that opens channels (signs once per provider)
      --route <${ROUTES.join('|')}>   default route (per request: model suffix :cheap :fast :trusted :private)
      --deposit <usd>           deposit per new channel (default 2)
      --daily-cap <usd>         stop spending after this much per day (default 5)
      --max-price <in/out>      never route above this price, dollars per million tokens, e.g. 0.50/1.50 (per request: x-orrery-max-price)
      --max-cost <usd>          a dollar budget for each request, e.g. 0.002 (per request: x-orrery-max-cost)
      --min-reputation <0-1>    auto route ignores providers below this (default 0.2)
      --alias <from=to,...>     answer other model names with a network model, e.g. 'claude-*=llama-3.3-70b'
      --allow-dev-enclaves      accept software attestation (local testing only)
  ${CLI} mcp                     an MCP server on stdio for agents, in front of your running router
      --router <url>            the router to use (default http://127.0.0.1:${ROUTER_PORT})
  ${CLI} connect <${CLIENTS.join('|')}>   the settings a client needs to use your router
      --model <id>              network model to use (default gpt-oss-120b)   --router <url>
      --write                   codex only: write $CODEX_HOME/orrery.config.toml (your config.toml is left alone)
  ${CLI} bench <model> [--n 3] [--json]   ask every provider of a model a few short questions through your router (paid) and compare
  ${CLI} spend [--since 24h|7d] [--by model|provider] [--json]   what your router paid, from its own log of answers
  ${CLI} doctor [--wallet <keypair.json> | --address <pubkey>] [--json]   check the RPC, the program, every listing, a wallet and the router (reads only)
  ${CLI} models                  every model on the network, cheapest price, provider count
  ${CLI} quote <model> [--in 2000 | --prompt "..."] [--out 500] [--cached 0.8] [--json]   what one request costs at every provider, from prices on chain (nothing is sent or paid)
  ${CLI} providers               every listed provider and what the chain says about it
  ${CLI} channels [--wallet <keypair.json> | --address <pubkey>]   your router's channels and what the chain says about each, plus any it has no record of
  ${CLI} close <channel> --wallet <keypair.json>            start closing (the provider keeps a grace period)
  ${CLI} close <channel> --wallet <keypair.json> --finish   after the grace period: the rest comes back to you
  ${CLI} provider init    find a local model server (Ollama, vLLM, llama.cpp, LM Studio, SGLang) and write provider.json
      --upstream <url> --name <name> --public-url <url> --out <file> --force
  ${CLI} provider start   --config provider.json
  ${CLI} provider register --config provider.json --wallet <keypair.json>   list or update on chain
  ${CLI} provider attest  --config provider.json   post the enclave claim (node key signs)
  ${CLI} provider redeem  --config provider.json   redeem every channel now
  ${CLI} provider earnings --config provider.json [--since 24h] [--by model|channel]   what this node billed, from its own log
  ${CLI} provider compare --config provider.json [--json]   your prices next to every other listing of the same models

  --rpc <url>   Solana RPC (or ORRERY_RPC_URL)     --mint <address>  settlement mint (default USDC)
`;

async function router() {
  const conn = new Connection(rpc(), 'confirmed');
  const walletPath = flag('wallet', process.env.ORRERY_WALLET);
  const wallet = walletPath ? loadKeypair(expand(walletPath)) : null;
  const session = loadOrCreateKeypair(home('router', 'session.json'));
  const route = (flag('route', 'auto') as Route);
  if (!ROUTES.includes(route)) throw new Error(`unknown route ${route}`);
  const registry = new Registry(conn, { allowDev: has('allow-dev-enclaves'), measurements: (flag('enclave-images', '') ?? '').split(',').filter(Boolean) });
  const channels = new Channels(conn, wallet, session, mint(), home('router', 'channels.json'), {
    deposit: dollars(flag('deposit', '2')!), topUpBelow: dollars(flag('top-up-below', '0.25')!), dailyCap: dollars(flag('daily-cap', '5')!),
  });
  const port = Number(flag('port', String(ROUTER_PORT)));
  const r = new Router({ port, route, minReputation: Number(flag('min-reputation', '0.2')), registry, channels, conn, refreshSecs: Number(flag('refresh', '60')), holders: new HolderBook(conn), aliases: parseAliases(flag('alias', process.env.ORRERY_ALIASES)), maxPrice: parseCeiling(flag('max-price', process.env.ORRERY_MAX_PRICE)), maxCost: flag('max-cost', process.env.ORRERY_MAX_COST) || undefined });
  await r.start();
  const usable = registry.usable().length;
  console.log(`${NAME} router on http://127.0.0.1:${port}/v1  ·  ${usable} providers  ·  route ${route}  ·  ${wallet ? `wallet ${wallet.publicKey.toBase58().slice(0, 6)}…` : 'no wallet (read-only)'}`);
  console.log(`session key ${session.publicKey.toBase58()} signs vouchers; console at http://127.0.0.1:${port}/`);
  const s = await r.standing();
  if (s && s.balance > 0n) {
    const at = registry.usable().filter((e) => e.manifest?.holder?.tiers.some((t) => s.balance * 10_000n >= s.supply * BigInt(t.share))).length;
    console.log(`holder: this wallet holds ${sharePct(s)} of the network token's supply · holder prices at ${at} provider${at === 1 ? '' : 's'}`);
  }
}

async function listModels() {
  const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
  await registry.refresh();
  const rows = registry.catalog();
  if (!rows.length) return console.log('No models listed yet.');
  for (const m of rows) console.log(`${m.id.padEnd(40)} ${String(m.providers).padStart(3)} ${m.providers === 1 ? 'provider ' : 'providers'}  from ${perMillion(m.cheapest.input)} in · ${perMillion(m.cheapest.output)} out${m.cachedFrom !== null ? ` · cached in from ${perMillion(m.cachedFrom)}` : ''}${m.private ? `  · ${m.private} private` : ''}`);
}

const tiersText = (t?: HolderTier[]) => (t?.length ? `holders ${t.map((x) => `${x.share / 100}%→−${x.off / 100}%`).join(' ')}  ` : '');

async function listProviders() {
  const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
  await registry.refresh();
  for (const e of registry.entries.values()) {
    const a = e.account;
    console.log(`${e.address}  ${(e.manifest?.name ?? '?').padEnd(24)} ${a.active ? 'open  ' : 'closed'}  settled $${usd(a.settled, 2)} in ${a.redeems} redeems  ${e.manifest?.models.length ?? 0} models  ${tiersText(e.manifest?.holder?.tiers)}${e.tee ? `enclave: ${e.tee.reason}` : ''}${e.problem ? `  ✗ ${e.problem}` : ''}`);
  }
}

async function listChannels() {
  const conn = new Connection(rpc(), 'confirmed');
  const session = loadOrCreateKeypair(home('router', 'session.json'));
  const local = new Channels(conn, null, session, mint(), home('router', 'channels.json'), { deposit: 0n, topUpBelow: 0n, dailyCap: 0n }).list();
  const walletPath = flag('wallet', process.env.ORRERY_WALLET);
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
  for (const [channel, { a, signed }] of rows) {
    if (!a) {
      console.log(`${channel}  closed`);
      continue;
    }
    const state = a.closingAt === 0n ? 'open' : `closing, ready after ${new Date(Number(a.closingAt) * 1000).toISOString()}`;
    const head = `${channel}  provider ${a.provider.toBase58().slice(0, 8)}…  deposit $${usd(a.deposit, 2)}  redeemed $${usd(a.redeemed)}  ${state}`;
    if (signed !== null) {
      console.log(`${head}  you signed $${usd(signed)}`);
      continue;
    }
    const mine = a.sessionKey.equals(session.publicKey);
    const note = a.closingAt !== 0n
      ? 'not in your records'
      : mine
        ? 'not in your records; the router picks it back up on its next request to this provider'
        : `not in your records and signed by another session key; to get the deposit back: ${CLI} close ${channel} --wallet <keypair.json>`;
    console.log(`${head}  ${note}`);
  }
  if (!address) console.log(`Add --wallet <keypair.json> or --address <pubkey> to include channels this router has no record of.`);
}

async function provider(sub: string) {
  const cfgPath = flag('config');
  if (!cfgPath) throw new Error('--config <provider.json> is required');
  const cfg = JSON.parse(readFileSync(expand(cfgPath), 'utf8')) as ProviderConfig;
  cfg.rpcUrl = flag('rpc', process.env.ORRERY_RPC_URL ?? cfg.rpcUrl) ?? cfg.rpcUrl;
  cfg.listen = Number(flag('port', process.env.PORT ?? '')) || cfg.listen || PROVIDER_PORT;
  if (sub === 'compare') {
    const registry = new Registry(new Connection(cfg.rpcUrl ?? rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    const self = cfg.authority ? pda.provider(new PublicKey(cfg.authority)).toBase58() : null;
    const rows = compare(cfg.models.map((m) => ({ id: m.id, price: m.price })), registry.usable(), self);
    if (has('json')) return console.log(JSON.stringify(rows.map((r) => ({ ...r, myCost: usd(r.myCost), lowestCost: r.lowestCost === null ? null : usd(r.lowestCost) })), null, 2));
    return console.log(renderCompare(cfg.name, rows));
  }
  if (sub === 'earnings') {
    const by = flag('by', 'model') === 'channel' ? 'provider' : 'model';
    const since = flag('since', '24h')!;
    const log = `${expand(cfg.dataDir ?? home('provider'))}/served.jsonl`;
    const { rows, total } = summarize(readTrips(log), by, windowMs(since));
    if (!total.answers) return console.log(`No answers served in the last ${since}. The node logs each answer to ${log}.`);
    console.log(`"${cfg.name}", last ${since}, by ${by === 'provider' ? 'channel' : 'model'} (billed; routers sign the lower of the bill and their own math)`);
    for (const r of [...rows, total]) console.log(`${r.key.padEnd(24)} ${String(r.answers).padStart(7)} ${r.answers === 1 ? 'answer ' : 'answers'}  ${r.inputTokens.toLocaleString('en-US').padStart(10)} in  ${r.outputTokens.toLocaleString('en-US').padStart(9)} out  ${`$${usd(r.units)}`.padStart(11)}`);
    return;
  }
  const node = new ProviderNode(cfg);
  if (sub === 'start') {
    await node.listen();
    console.log(`${NAME} provider "${cfg.name}" on :${cfg.listen}  ·  listing ${node.pda.toBase58()}  ·  ${cfg.models.length} models  ·  manifest ${node.manifestHash.toString('hex').slice(0, 12)}…`);
    return;
  }
  if (sub === 'register') {
    const w = loadKeypair(expand(flag('wallet', cfg.wallet ?? '')!));
    if (!w.publicKey.equals(node.authority)) throw new Error('the wallet does not match the config authority');
    const exists = await node.conn.getAccountInfo(node.pda);
    const ix = exists ? node.updateInstruction(w.publicKey) : node.registerInstruction(w.publicKey);
    const sig = await sendAndConfirmTransaction(node.conn, new Transaction().add(ix), [w], { commitment: 'confirmed' });
    console.log(`${exists ? 'updated' : 'listed'} ${node.pda.toBase58()}  tx ${sig}`);
    return;
  }
  if (sub === 'attest') {
    const sig = await sendAndConfirmTransaction(node.conn, new Transaction().add(node.attestInstruction()), [node.node], { commitment: 'confirmed' });
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
  if (!cmd || cmd === 'help' || has('help')) return console.log(HELP);
  if (cmd === 'provider' && sub === 'init') {
    const out = flag('out', 'provider.json')!;
    if (existsSync(out) && !has('force')) throw new Error(`${out} exists; pass --force to replace it`);
    const found = await findUpstream(flag('upstream'));
    const cfg = draftConfig(found, { name: flag('name'), publicUrl: flag('public-url'), wallet: flag('wallet') });
    writeFileSync(out, `${JSON.stringify(cfg, null, 2)}\n`);
    console.log(`found ${found.name} at ${found.baseUrl} with ${found.models.length} model${found.models.length === 1 ? '' : 's'}: ${found.models.slice(0, 6).join(', ')}${found.models.length > 6 ? ', …' : ''}`);
    const emb = found.models.filter(isEmbeddingModel);
    if (emb.length) console.log(`${emb.join(', ')} ${emb.length === 1 ? 'is an embedding model' : 'are embedding models'}: listed for /v1/embeddings, priced on input tokens only ($0.02 per million to start)`);
    if (CACHE_REPORTING[found.name]) console.log(`each model also has a cached-input price (a quarter of input) for prompt-cache hits; start ${found.name} with ${CACHE_REPORTING[found.name]} so it reports them`);
    // Where the draft prices would stand against what is already listed, so the first edit is an informed one.
    if (!has('offline')) {
      const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: false, measurements: [] });
      const listed = await registry.refresh().then(() => registry.usable()).catch(() => null);
      if (listed) console.log(`\n${renderCompare(cfg.name, compare(cfg.models.map((m) => ({ id: m.id, price: m.price })), listed, null))}\n`);
    }
    console.log(`wrote ${out}. Next:\n  1. set publicUrl to an address routers can reach, and your prices (micro-USDC per million tokens; 500000 = $0.50)\n  2. ${CLI} provider compare --config ${out} to see where new prices would stand\n  3. ${CLI} provider register --config ${out} --wallet <keypair.json>\n  4. ${CLI} provider start --config ${out}`);
    return;
  }
  if (cmd === 'connect') {
    if (!sub || !(CLIENTS as readonly string[]).includes(sub)) throw new Error(`usage: ${CLI} connect <${CLIENTS.join('|')}> [--model <id>] [--write]`);
    const routerUrl = flag('router', `http://127.0.0.1:${ROUTER_PORT}`)!;
    const model = flag('model', 'gpt-oss-120b')!;
    const profilePath = `${expand(process.env.CODEX_HOME ?? '~/.codex')}/orrery.config.toml`;
    if (!has('write')) return console.log(instructions(sub as Client, routerUrl, model, profilePath));
    if (sub !== 'codex') throw new Error('--write is for codex; the others take environment variables');
    if (existsSync(profilePath) && !has('force')) throw new Error(`${profilePath} exists; pass --force to replace it`);
    mkdirSync(dirname(profilePath), { recursive: true });
    const ctx = await contextFromRouter(routerUrl, model);
    writeFileSync(profilePath, codexProfile(routerUrl, model, ctx));
    return console.log(`wrote ${profilePath}${ctx ? ` (context window ${ctx}, from your router)` : ''}\nrun: codex --profile orrery`);
  }
  if (cmd === 'bench') {
    if (!sub) throw new Error(`usage: ${CLI} bench <model> [--n 3] [--router <url>]`);
    const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    const providers = registry.usable().filter((e) => e.manifest!.models.some((m) => m.id === sub));
    if (!providers.length) throw new Error(`no provider on the network lists ${sub}; see ${CLI} models`);
    const rows = await bench({ model: sub, providers, router: flag('router', `http://127.0.0.1:${ROUTER_PORT}`)!, n: Math.max(1, Math.min(20, Number(flag('n', '3')))) });
    if (has('json')) return console.log(JSON.stringify({ model: sub, providers: rows.map((r) => ({ name: r.name, address: r.address, asked: r.asked, answered: r.answered, ttftMsMedian: median(r.ttftMs) || null, totalMsMedian: median(r.totalMs) || null, perAnswer: r.units.length ? usd(r.units.reduce((a, b) => a + b, 0n) / BigInt(r.units.length)) : null, listed: r.price, error: r.error ?? null })) }, null, 2));
    return console.log(renderBench(sub, rows));
  }
  if (cmd === 'spend') {
    const by = flag('by', 'model') === 'provider' ? 'provider' : 'model';
    const since = flag('since', '24h')!;
    const { rows, total } = summarize(readTrips(home('router', 'trips.jsonl')), by, windowMs(since));
    if (has('json')) return console.log(JSON.stringify({ since, by, rows: [...rows, total].map((r) => ({ key: r.key, answers: r.answers, inputTokens: r.inputTokens, outputTokens: r.outputTokens, usd: usd(r.units), cacheKept: r.cacheKept })) }, null, 2));
    if (!total.answers) return console.log(`No answers in the last ${since}. The router logs each answer it pays for to ${home('router', 'trips.jsonl')}.`);
    const line = (r: { key: string; answers: number; inputTokens: number; outputTokens: number; units: bigint; cacheKept: number }) => `${r.key.padEnd(26)} ${String(r.answers).padStart(7)} ${r.answers === 1 ? 'answer ' : 'answers'}  ${r.inputTokens.toLocaleString('en-US').padStart(10)} in  ${r.outputTokens.toLocaleString('en-US').padStart(9)} out  ${`$${usd(r.units)}`.padStart(11)}${r.cacheKept ? `  ${r.cacheKept} kept for cache` : ''}`;
    console.log(`last ${since}, by ${by}`);
    for (const r of rows) console.log(line(r));
    console.log(line(total));
    return;
  }
  if (cmd === 'doctor') {
    const walletPath = flag('wallet', process.env.ORRERY_WALLET);
    const address = flag('address');
    const sessionPath = home('router', 'session.json');
    const lines = await doctor({ rpc: rpc(), mint: mint(), session: existsSync(sessionPath) ? loadKeypair(sessionPath).publicKey : undefined, wallet: address ? new PublicKey(address) : walletPath ? loadKeypair(expand(walletPath)).publicKey : undefined, router: flag('router', `http://127.0.0.1:${ROUTER_PORT}`)!, deposit: dollars(flag('deposit', '2')!), allowDev: has('allow-dev-enclaves'), version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
    console.log(has('json') ? JSON.stringify(lines.map((l) => ({ ...l, what: l.what.trim() })), null, 2) : render(lines));
    if (lines.some((l) => l.ok === false)) process.exitCode = 1;
    return;
  }
  if (cmd === 'router') return router();
  if (cmd === 'mcp') return serveMcp(flag('router', process.env.ORRERY_ROUTER_URL ?? `http://127.0.0.1:${ROUTER_PORT}`)!, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (cmd === 'models') return listModels();
  if (cmd === 'quote') {
    const model = sub;
    if (!model) throw new Error(`usage: ${CLI} quote <model> [--in 2000 | --prompt "..."] [--out 500] [--cached 0.8] [--json]`);
    const prompt = flag('prompt');
    const inTokens = prompt ? estimateInputTokens({ messages: [{ role: 'user', content: prompt }] }) : Number(flag('in', '2000'));
    const outTokens = Number(flag('out', '500'));
    const cachedShare = Math.max(0, Math.min(1, Number(flag('cached', '0.8'))));
    const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
    await registry.refresh();
    const rows = quote(registry.usable(), model, inTokens, outTokens, cachedShare);
    if (has('json')) return console.log(JSON.stringify({ model, inTokens, outTokens, cachedShare, rows: rows.map((r) => ({ ...r, full: usd(r.full), cached: r.cached === null ? null : usd(r.cached) })) }, null, 2));
    return console.log(renderQuote(model, inTokens, outTokens, cachedShare, rows));
  }
  if (cmd === 'providers') return listProviders();
  if (cmd === 'provider') return provider(sub ?? 'start');
  if (cmd === 'channels') return listChannels();
  if (cmd === 'close') {
    const walletPath = flag('wallet', process.env.ORRERY_WALLET);
    if (!sub || !walletPath) throw new Error(`usage: ${CLI} close <channel> --wallet <keypair.json> [--finish]`);
    const w = loadKeypair(expand(walletPath));
    const ch = new PublicKey(sub);
    const conn = new Connection(rpc(), 'confirmed');
    const info = await conn.getAccountInfo(ch);
    if (!info) return console.log(`${ch.toBase58()} is already closed`);
    const c = decodeChannel(info.data);
    if (!c.payer.equals(w.publicKey)) throw new Error('this wallet did not open that channel');
    if (!has('finish')) {
      if (c.closingAt !== 0n) return console.log(`already closing; the rest can come back after ${new Date(Number(c.closingAt) * 1000).toISOString()} with --finish`);
      await sendAndConfirmTransaction(conn, new Transaction().add(ins.requestClose(w.publicKey, ch)), [w]);
      const cfg = decodeConfig((await conn.getAccountInfo(pda.config()))!.data);
      return console.log(`closing ${ch.toBase58()}; the provider has ${cfg.closeGraceSecs}s to redeem, then run: ${CLI} close ${ch.toBase58()} --wallet ${walletPath} --finish`);
    }
    if (c.closingAt === 0n) throw new Error(`start the close first: ${CLI} close ${ch.toBase58()} --wallet ${walletPath}`);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < c.closingAt) throw new Error(`the grace period ends at ${new Date(Number(c.closingAt) * 1000).toISOString()}`);
    const prov = decodeProvider((await conn.getAccountInfo(c.provider))!.data);
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ins.closeChannel(w.publicKey, prov.authority, ch, w.publicKey, c.mint)), [w]);
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
