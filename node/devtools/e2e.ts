// End to end on a local validator: the real program, three provider nodes in front of mock models, the router, a
// dozen requests on every route, a provider going dark mid-run, on-chain redemption, a provider releasing its
// channel, and a final check that every unit of USDC is where it should be.
//   cd node && npx tsx devtools/e2e.ts     (needs program/target/deploy/switchyard.so: anchor build --arch v2)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';

const ROOT = new URL('../../', import.meta.url).pathname;
const WORK = join(ROOT, '.local/e2e');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.env.SWITCHYARD_HOME = join(WORK, 'home');

const { PROGRAM_ID } = await import('../src/brand.ts');
const { decodeChannel, decodeConfig, decodeProvider, ins, pda } = await import('../src/chain/program.ts');
const { loadOrCreateKeypair } = await import('../src/keys.ts');
const { ProviderNode } = await import('../src/provider/node.ts');
const { Channels } = await import('../src/router/channels.ts');
const { Registry } = await import('../src/router/registry.ts');
const { Router } = await import('../src/router/server.ts');
const { usd } = await import('../src/pricing.ts');

const RPC_PORT = 18899;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const ROUTER = 'http://127.0.0.1:17171';
const USD = 1_000_000n;
const so = join(ROOT, 'program/target/deploy/switchyard.so');
if (!existsSync(so)) throw new Error('build the program first: cd program && anchor build --arch v2');

const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
};

const admin = loadOrCreateKeypair(join(ROOT, '.local/keys/local-wallet.json'));
const validator = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', join(WORK, 'ledger'), '--rpc-port', String(RPC_PORT), '--faucet-port', '19900', '--upgradeable-program', PROGRAM_ID, so, admin.publicKey.toBase58()], { stdio: 'ignore' });
procs.push(validator);
const conn = new Connection(RPC, 'confirmed');
for (let i = 0; ; i++) {
  try {
    await conn.getLatestBlockhash();
    break;
  } catch {
    if (i > 60) throw new Error('validator did not start');
    await sleep(500);
  }
}
console.log('validator up');

const fund = async (k: PublicKey, sol = 5) => {
  const sig = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
};
await fund(admin.publicKey, 50);
const usdc = await createMint(conn, admin, admin.publicKey, null, 6);
await sendAndConfirmTransaction(conn, new Transaction().add(ins.initialize(admin.publicKey, usdc, { closeGraceSecs: 600n, unbondSecs: 3_600n, minDeposit: USD / 10n })), [admin]);
console.log(`program initialized, settlement mint ${usdc.toBase58()}`);

const upstreams: [number, number, string][] = [[19101, 220, 'kestrel'], [19102, 40, 'ironbridge'], [19103, 90, 'vault-nine']];
for (const [port, delay, label] of upstreams) {
  procs.push(spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/devtools/mock-upstream.ts'), String(port), String(delay), label], { stdio: 'ignore' }));
}
await sleep(1_500);

const providerSpecs = [
  { name: 'Kestrel GPU Co-op', region: 'eu-north', port: 17281, up: 19101, tee: false, models: [['llama-3.3-70b', 120_000, 300_000], ['qwen3-32b', 80_000, 200_000]] },
  { name: 'Ironbridge Compute', region: 'us-east', port: 17282, up: 19102, tee: false, models: [['llama-3.3-70b', 200_000, 450_000], ['deepseek-v3', 270_000, 1_100_000]] },
  { name: 'Vault Nine', region: 'eu-west', port: 17283, up: 19103, tee: true, models: [['llama-3.3-70b', 250_000, 600_000], ['qwen3-32b', 150_000, 300_000]] },
] as const;

const nodes: InstanceType<typeof ProviderNode>[] = [];
const wallets: Keypair[] = [];
for (const s of providerSpecs) {
  const wallet = Keypair.generate();
  wallets.push(wallet);
  const dir = join(WORK, 'providers', s.name.split(' ')[0].toLowerCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wallet.json'), JSON.stringify(Array.from(wallet.secretKey)));
  const node = new ProviderNode({
    name: s.name, region: s.region, listen: s.port, host: '127.0.0.1', publicUrl: `http://127.0.0.1:${s.port}`, rpcUrl: RPC, settleMint: usdc.toBase58(),
    wallet: join(dir, 'wallet.json'), dataDir: dir, upstream: { baseUrl: `http://127.0.0.1:${s.up}/v1` },
    models: s.models.map(([id, input, output]) => ({ id, context: 131_072, maxOutput: 4_096, price: { input, output } })),
    tee: s.tee ? { mode: 'dev', kind: 3 } : undefined, redeem: { everySecs: 3_600, minUnits: 1 },
  });
  node.log = (l) => console.log(`    [${s.name.split(' ')[0]}] ${l}`);
  await fund(wallet.publicKey);
  await fund(node.node.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(node.registerInstruction(wallet.publicKey)), [wallet]);
  if (s.tee) await sendAndConfirmTransaction(conn, new Transaction().add(node.attestInstruction()), [node.node]);
  await node.listen();
  nodes.push(node);
}
console.log('three providers listed');

const user = Keypair.generate();
await fund(user.publicKey);
const userTokens = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, user.publicKey);
await mintTo(conn, admin, usdc, userTokens.address, admin, 100n * USD);
const session = loadOrCreateKeypair(join(WORK, 'home/router/session.json'));
const registry = new Registry(conn, { allowDev: true, measurements: [] });
const channels = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
const router = new Router({ port: 17171, route: 'auto', minReputation: 0, registry, channels, conn, refreshSecs: 3_600, log: (l) => console.log(`    [router] ${l}`) });
await router.start();
console.log(`router up with ${registry.usable().length} providers`);

const ask = async (model: string, opts: { stream?: boolean; header?: Record<string, string> } = {}) => {
  const r = await fetch(`${ROUTER}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(opts.header ?? {}) },
    body: JSON.stringify({ model, stream: !!opts.stream, max_tokens: 64, messages: [{ role: 'user', content: 'In one sentence: how does a payment channel settle?' }] }),
  });
  if (opts.stream) {
    const text = await r.text();
    const content = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
    return { status: r.status, provider: r.headers.get('x-yard-provider'), content, raw: text };
  }
  const j = await r.json();
  return { status: r.status, provider: r.headers.get('x-yard-provider'), content: j.choices?.[0]?.message?.content ?? '', cost: r.headers.get('x-yard-cost'), body: j };
};
const nameOf = (addr: string | null) => registry.get(addr ?? '')?.manifest?.name ?? addr;

console.log('\nrequests');
const models = await (await fetch(`${ROUTER}/v1/models`)).json();
check('/v1/models lists the network catalog', models.data.length === 3, models.data.map((m: { id: string; providers: number }) => `${m.id}×${m.providers}`).join(' '));

let r = await ask('llama-3.3-70b:cheap');
check('price route picks the cheapest llama', nameOf(r.provider) === 'Kestrel GPU Co-op' && r.content.length > 20, `${nameOf(r.provider)}, $${r.cost}`);
r = await ask('deepseek-v3', { stream: true });
check('streaming works and only Ironbridge has deepseek', nameOf(r.provider) === 'Ironbridge Compute' && r.content.includes('Solana'), `${r.content.slice(0, 40)}…`);
r = await ask('qwen3-32b:private');
check('privacy route seals the request to the only enclave', nameOf(r.provider) === 'Vault Nine' && r.content.length > 20);
r = await ask('llama-3.3-70b', { header: { 'x-yard-route': 'privacy' } });
check('route header works too', nameOf(r.provider) === 'Vault Nine');
for (let i = 0; i < 3; i++) await ask('llama-3.3-70b:fast');
r = await ask('llama-3.3-70b:fast');
check('speed route settles on the provider with the fastest first token', nameOf(r.provider) === 'Ironbridge Compute', nameOf(r.provider) ?? '');
for (let i = 0; i < 4; i++) await ask(i % 2 ? 'qwen3-32b' : 'llama-3.3-70b', { stream: i % 2 === 0 });

await nodes[0].close();
r = await ask('llama-3.3-70b:cheap');
check('when the cheapest provider goes dark the request falls through', r.status === 200 && nameOf(r.provider) !== 'Kestrel GPU Co-op', `${nameOf(r.provider)} answered`);
const trips = router.trips;
check('router logged every answered request', trips.length === 13, `${trips.length} trips`);

console.log('\nsettlement');
for (const n of nodes) await n.redeemDue(1n);
const balance = async (owner: PublicKey) => {
  try {
    return (await getAccount(conn, pda.ata(owner, usdc))).amount;
  } catch {
    return 0n;
  }
};
let paidTotal = 0n;
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i];
  const ch = channels.get(n.pda.toBase58());
  const got = await balance(wallets[i].publicKey);
  paidTotal += got;
  const acct = decodeProvider((await conn.getAccountInfo(n.pda))!.data);
  const spent = ch?.cumulative ?? 0n;
  check(`${providerSpecs[i].name} redeemed exactly what the router signed`, got === spent && acct.settled === got, `$${usd(got)} over ${acct.redeems} redeem(s)`);
}

const iron = nodes[1];
const ironCh = channels.get(iron.pda.toBase58())!;
const before = await balance(user.publicKey);
const vaultBefore = (await getAccount(conn, pda.ata(new PublicKey(ironCh.channel), usdc))).amount;
await sendAndConfirmTransaction(conn, new Transaction().add(ins.closeChannel(iron.node.publicKey, wallets[1].publicKey, new PublicKey(ironCh.channel), user.publicKey, usdc)), [iron.node]);
const after = await balance(user.publicKey);
check('a provider releasing its channel sends the rest straight back to the user', after - before === vaultBefore, `refund $${usd(vaultBefore)}`);

let inVaults = 0n;
for (const c of channels.list()) {
  const info = await conn.getAccountInfo(new PublicKey(c.channel));
  if (!info) continue;
  inVaults += (await getAccount(conn, pda.ata(new PublicKey(c.channel), usdc))).amount;
  decodeChannel(info.data);
}
const userNow = await balance(user.publicKey);
check('no fee anywhere: user + providers + open deposits = 100 USDC', userNow + paidTotal + inVaults === 100n * USD, `user $${usd(userNow, 4)} · providers $${usd(paidTotal, 4)} · deposits $${usd(inVaults, 4)}`);
const cfg = decodeConfig((await conn.getAccountInfo(pda.config()))!.data);
check('program totals agree', cfg.settled === paidTotal && cfg.providers === 3n, `settled $${usd(cfg.settled)} · ${cfg.channels} channels`);

const summary = {
  ranAt: new Date().toISOString(), program: PROGRAM_ID, requests: trips.length, settledUnits: paidTotal.toString(),
  trips: trips.map((t) => ({ route: t.route, model: t.model, provider: t.providerName, tokens: `${t.inputTokens}+${t.outputTokens}`, cost: t.cost, ttftMs: t.ttftMs, sealed: t.sealed, fellThrough: t.fellThrough })),
  checks,
};
writeFileSync(join(WORK, 'summary.json'), JSON.stringify(summary, null, 2));
await router.close();
for (const n of nodes.slice(1)) await n.close();
for (const p of procs) p.kill('SIGTERM');
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
