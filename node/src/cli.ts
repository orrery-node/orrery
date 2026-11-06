#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { CLI, NAME, PROVIDER_PORT, ROUTER_PORT, USDC_MAINNET } from './brand.ts';
import { decodeProvider, ins, pda } from './chain/program.ts';
import { home, loadKeypair, loadOrCreateKeypair } from './keys.ts';
import { perMillion, usd } from './pricing.ts';
import { ProviderNode, type ProviderConfig } from './provider/node.ts';
import { Channels } from './router/channels.ts';
import { ROUTES, type Route } from './router/policy.ts';
import { Registry } from './router/registry.ts';
import { Router } from './router/server.ts';

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
      --allow-dev-enclaves      accept software attestation (local testing only)
  ${CLI} models                  every model on the network, cheapest price, provider count
  ${CLI} providers               every listed provider and what the chain says about it
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
  const r = new Router({ port, route, minReputation: Number(flag('min-reputation', '0.2')), registry, channels, conn, refreshSecs: Number(flag('refresh', '60')) });
  await r.start();
  const usable = registry.usable().length;
  console.log(`${NAME} router on http://127.0.0.1:${port}/v1  ·  ${usable} providers  ·  route ${route}  ·  ${wallet ? `wallet ${wallet.publicKey.toBase58().slice(0, 6)}…` : 'no wallet (read-only)'}`);
  console.log(`session key ${session.publicKey.toBase58()} signs vouchers; console at http://127.0.0.1:${port}/`);
}

async function listModels() {
  const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
  await registry.refresh();
  const rows = registry.catalog();
  if (!rows.length) return console.log('No models listed yet.');
  for (const m of rows) console.log(`${m.id.padEnd(40)} ${String(m.providers).padStart(3)} providers  from ${perMillion(m.cheapest.input)} in · ${perMillion(m.cheapest.output)} out${m.private ? `  · ${m.private} private` : ''}`);
}

async function listProviders() {
  const registry = new Registry(new Connection(rpc(), 'confirmed'), { allowDev: has('allow-dev-enclaves'), measurements: [] });
  await registry.refresh();
  for (const e of registry.entries.values()) {
    const a = e.account;
    console.log(`${e.address}  ${(e.manifest?.name ?? '?').padEnd(24)} ${a.active ? 'open  ' : 'closed'}  settled $${usd(a.settled, 2)} in ${a.redeems} redeems  ${e.manifest?.models.length ?? 0} models  ${e.tee ? `enclave: ${e.tee.reason}` : ''}${e.problem ? `  ✗ ${e.problem}` : ''}`);
  }
}

async function provider(sub: string) {
  const cfgPath = flag('config');
  if (!cfgPath) throw new Error('--config <provider.json> is required');
  const cfg = JSON.parse(readFileSync(expand(cfgPath), 'utf8')) as ProviderConfig;
  cfg.rpcUrl = flag('rpc', cfg.rpcUrl) ?? cfg.rpcUrl;
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
  if (cmd === 'router') return router();
  if (cmd === 'models') return listModels();
  if (cmd === 'providers') return listProviders();
  if (cmd === 'provider') return provider(sub ?? 'start');
  if (cmd === 'close') {
    const w = loadKeypair(expand(flag('wallet')!));
    const ch = new PublicKey(sub);
    const conn = new Connection(rpc(), 'confirmed');
    await sendAndConfirmTransaction(conn, new Transaction().add(ins.requestClose(w.publicKey, ch)), [w]);
    return console.log(`closing ${ch.toBase58()}; after the grace period run the close again with --finish`);
  }
  console.log(HELP);
  process.exitCode = 1;
}

void pda;
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
