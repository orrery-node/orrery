#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CLI, NAME, PROVIDER_PORT, ROUTER_PORT, USDC_MAINNET } from './brand.ts';
import { decodeChannel, decodeConfig, decodeProvider, ins, pda } from './chain/program.ts';
import { home, loadKeypair, loadOrCreateKeypair } from './keys.ts';
import { HolderBook, sharePct, type HolderTier } from './holder.ts';
import { perMillion, usd } from './pricing.ts';
import { ProviderNode, type ProviderConfig } from './provider/node.ts';
import { Channels } from './router/channels.ts';
import { parseAliases, ROUTES, type Route } from './router/policy.ts';
import { Registry } from './router/registry.ts';
import { Router } from './router/server.ts';
import { serveMcp } from './mcp.ts';
import { draftConfig, findUpstream } from './provider/init.ts';

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
      --min-reputation <0-1>    auto route ignores providers below this (default 0.2)
      --alias <from=to,...>     answer other model names with a network model, e.g. 'claude-*=llama-3.3-70b'
      --allow-dev-enclaves      accept software attestation (local testing only)
  ${CLI} mcp                     an MCP server on stdio for agents, in front of your running router
      --router <url>            the router to use (default http://127.0.0.1:${ROUTER_PORT})
  ${CLI} models                  every model on the network, cheapest price, provider count
  ${CLI} providers               every listed provider and what the chain says about it
  ${CLI} channels                your router's channels and what the chain says about each
  ${CLI} close <channel> --wallet <keypair.json>            start closing (the provider keeps a grace period)
  ${CLI} close <channel> --wallet <keypair.json> --finish   after the grace period: the rest comes back to you
  ${CLI} provider init    find a local model server (Ollama, vLLM, llama.cpp, LM Studio, SGLang) and write provider.json
      --upstream <url> --name <name> --public-url <url> --out <file> --force
  ${CLI} provider start   --config provider.json
  ${CLI} provider register --config provider.json --wallet <keypair.json>   list or update on chain
  ${CLI} provider attest  --config provider.json   post the enclave claim (node key signs)
  ${CLI} provider redeem  --config provider.json   redeem every channel now

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
  const r = new Router({ port, route, minReputation: Number(flag('min-reputation', '0.2')), registry, channels, conn, refreshSecs: Number(flag('refresh', '60')), holders: new HolderBook(conn), aliases: parseAliases(flag('alias', process.env.ORRERY_ALIASES)) });
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
  for (const m of rows) console.log(`${m.id.padEnd(40)} ${String(m.providers).padStart(3)} providers  from ${perMillion(m.cheapest.input)} in · ${perMillion(m.cheapest.output)} out${m.private ? `  · ${m.private} private` : ''}`);
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
  if (!local.length) return console.log('No channels yet. The first request to a provider opens one.');
  for (const c of local) {
    const info = await conn.getAccountInfo(new PublicKey(c.channel));
    if (!info) {
      console.log(`${c.channel}  closed`);
      continue;
    }
    const a = decodeChannel(info.data);
    const state = a.closingAt === 0n ? 'open' : `closing, ready after ${new Date(Number(a.closingAt) * 1000).toISOString()}`;
    console.log(`${c.channel}  provider ${c.provider.slice(0, 8)}…  deposit $${usd(a.deposit, 2)}  you signed $${usd(c.cumulative)}  redeemed $${usd(a.redeemed)}  ${state}`);
  }
}

async function provider(sub: string) {
  const cfgPath = flag('config');
  if (!cfgPath) throw new Error('--config <provider.json> is required');
  const cfg = JSON.parse(readFileSync(expand(cfgPath), 'utf8')) as ProviderConfig;
  cfg.rpcUrl = flag('rpc', process.env.ORRERY_RPC_URL ?? cfg.rpcUrl) ?? cfg.rpcUrl;
  cfg.listen = Number(flag('port', process.env.PORT ?? '')) || cfg.listen || PROVIDER_PORT;
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
    console.log(`wrote ${out}. Next:\n  1. set publicUrl to an address routers can reach, and your prices (micro-USDC per million tokens; 500000 = $0.50)\n  2. ${CLI} provider register --config ${out} --wallet <keypair.json>\n  3. ${CLI} provider start --config ${out}`);
    return;
  }
  if (cmd === 'router') return router();
  if (cmd === 'mcp') return serveMcp(flag('router', process.env.ORRERY_ROUTER_URL ?? `http://127.0.0.1:${ROUTER_PORT}`)!, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  if (cmd === 'models') return listModels();
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
