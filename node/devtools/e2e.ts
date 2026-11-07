// End to end on a local validator: the real program, four provider nodes in front of mock models, the router, a
// dozen requests on every route, holder pricing for a wallet that holds the network token, a provider going dark
// mid-run, on-chain redemption, a provider releasing its channel, and a final check that every unit of USDC is where
// it should be.
//   cd node && npx tsx devtools/e2e.ts     (needs program/target/deploy/orrery.so: anchor build --arch v2)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';

const ROOT = new URL('../../', import.meta.url).pathname;
const WORK = join(ROOT, '.local/e2e');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.env.ORRERY_HOME = join(WORK, 'home');

const { PROGRAM_ID } = await import('../src/brand.ts');
const { decodeChannel, decodeConfig, decodeProvider, ins, pda } = await import('../src/chain/program.ts');
const { loadOrCreateKeypair } = await import('../src/keys.ts');
const { ProviderNode } = await import('../src/provider/node.ts');
const { Channels } = await import('../src/router/channels.ts');
const { Registry } = await import('../src/router/registry.ts');
const { Router } = await import('../src/router/server.ts');
const { parseAliases } = await import('../src/router/policy.ts');
const { costOf, usd } = await import('../src/pricing.ts');
const { discounted, HolderBook, sharePct } = await import('../src/holder.ts');

const RPC_PORT = 18899;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const ROUTER = 'http://127.0.0.1:17171';
const USD = 1_000_000n;
const so = join(ROOT, 'program/target/deploy/orrery.so');
if (!existsSync(so)) throw new Error('build the program first: cd program && anchor build --arch v2');

const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
};

const admin = loadOrCreateKeypair(join(ROOT, '.local/keys/local-wallet.json'));
const validator = spawn('solana-test-validator', ['--reset', '--quiet', '--ledger', join(WORK, 'ledger'), '--rpc-port', String(RPC_PORT), '--faucet-port', '19961', '--gossip-port', '18690', '--dynamic-port-range', '18700-18790', '--upgradeable-program', PROGRAM_ID, so, admin.publicKey.toBase58()], { stdio: 'ignore' });
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
const TOKEN = 1_000_000n;
const orey = await createMint(conn, admin, admin.publicKey, null, 6);
await sendAndConfirmTransaction(conn, new Transaction().add(ins.setBondMint(admin.publicKey, orey)), [admin]);
const adminOrey = await getOrCreateAssociatedTokenAccount(conn, admin, orey, admin.publicKey);
await mintTo(conn, admin, orey, adminOrey.address, admin, 980_000_000n * TOKEN);
console.log(`network token ${orey.toBase58()} set as the bond mint`);
const HOLDER_TIERS = [{ share: 10, off: 2_000 }, { share: 100, off: 3_500 }];

const upstreams: [number, number, string][] = [[19101, 220, 'kestrel'], [19102, 40, 'ironbridge'], [19103, 90, 'vault-nine'], [19104, 70, 'halo']];
for (const [port, delay, label] of upstreams) {
  procs.push(spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/devtools/mock-upstream.ts'), String(port), String(delay), label], { stdio: 'ignore' }));
}
await sleep(1_500);

const providerSpecs = [
  { name: 'Kestrel GPU Co-op', region: 'eu-north', port: 17281, up: 19101, tee: false, models: [['llama-3.3-70b', 120_000, 300_000], ['qwen3-32b', 80_000, 200_000]] },
  { name: 'Ironbridge Compute', region: 'us-east', port: 17282, up: 19102, tee: false, resume: true, models: [['llama-3.3-70b', 200_000, 450_000], ['deepseek-v3', 270_000, 1_100_000]] },
  { name: 'Vault Nine', region: 'eu-west', port: 17283, up: 19103, tee: true, resume: true, models: [['llama-3.3-70b', 250_000, 600_000], ['qwen3-32b', 150_000, 300_000]] },
  { name: 'Halo Compute', region: 'ap-northeast', port: 17284, up: 19104, tee: false, holder: true, models: [['gemma-3-27b', 200_000, 800_000]] },
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
    tee: s.tee ? { mode: 'dev', kind: 3 } : undefined, redeem: { everySecs: 3_600, minUnits: 1 }, resume: 'resume' in s ? s.resume : undefined,
    holder: 'holder' in s ? { tiers: HOLDER_TIERS } : undefined,
  });
  node.log = (l) => console.log(`    [${s.name.split(' ')[0]}] ${l}`);
  await fund(wallet.publicKey);
  await fund(node.node.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(node.registerInstruction(wallet.publicKey)), [wallet]);
  if (s.tee) await sendAndConfirmTransaction(conn, new Transaction().add(node.attestInstruction()), [node.node]);
  await node.listen();
  nodes.push(node);
}
console.log(`${providerSpecs.length} providers listed, one with holder prices`);

const user = Keypair.generate();
await fund(user.publicKey);
const userTokens = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, user.publicKey);
await mintTo(conn, admin, usdc, userTokens.address, admin, 100n * USD);
const userOrey = await getOrCreateAssociatedTokenAccount(conn, admin, orey, user.publicKey);
await mintTo(conn, admin, orey, userOrey.address, admin, 20_000_000n * TOKEN);
const session = loadOrCreateKeypair(join(WORK, 'home/router/session.json'));
const registry = new Registry(conn, { allowDev: true, measurements: [] });
const channels = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
const router = new Router({ port: 17171, route: 'auto', minReputation: 0, registry, channels, conn, refreshSecs: 3_600, log: (l) => console.log(`    [router] ${l}`), holders: new HolderBook(conn), aliases: parseAliases('claude-*=llama-3.3-70b') });
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
    return { status: r.status, provider: r.headers.get('x-orrery-provider'), content, raw: text };
  }
  const j = await r.json();
  return { status: r.status, provider: r.headers.get('x-orrery-provider'), content: j.choices?.[0]?.message?.content ?? '', cost: r.headers.get('x-orrery-cost'), body: j };
};
const nameOf = (addr: string | null) => registry.get(addr ?? '')?.manifest?.name ?? addr;

console.log('\nrequests');
const models = await (await fetch(`${ROUTER}/v1/models`)).json();
check('/v1/models lists the network catalog', models.data.length === 4, models.data.map((m: { id: string; providers: number }) => `${m.id}×${m.providers}`).join(' '));

let r = await ask('llama-3.3-70b:cheap');
check('price route picks the cheapest llama', nameOf(r.provider) === 'Kestrel GPU Co-op' && r.content.length > 20, `${nameOf(r.provider)}, $${r.cost}`);
r = await ask('deepseek-v3', { stream: true });
check('streaming works and only Ironbridge has deepseek', nameOf(r.provider) === 'Ironbridge Compute' && r.content.includes('Solana'), `${r.content.slice(0, 40)}…`);
r = await ask('qwen3-32b:private');
check('privacy route seals the request to the only enclave', nameOf(r.provider) === 'Vault Nine' && r.content.length > 20);
r = await ask('llama-3.3-70b', { header: { 'x-orrery-route': 'privacy' } });
check('route header works too', nameOf(r.provider) === 'Vault Nine');
for (let i = 0; i < 3; i++) await ask('llama-3.3-70b:fast');
r = await ask('llama-3.3-70b:fast');
check('speed route settles on the provider with the fastest first token', nameOf(r.provider) === 'Ironbridge Compute', nameOf(r.provider) ?? '');
for (let i = 0; i < 4; i++) await ask(i % 2 ? 'qwen3-32b' : 'llama-3.3-70b', { stream: i % 2 === 0 });

const standing = await router.standing(true);
r = await ask('gemma-3-27b');
const haloTrip = router.trips[router.trips.length - 1];
const haloPrice = { input: 200_000, output: 800_000 };
const listCost = costOf(haloPrice, haloTrip.inputTokens, haloTrip.outputTokens);
const holderCost = costOf(discounted(haloPrice, 3_500), haloTrip.inputTokens, haloTrip.outputTokens);
check('a wallet holding 2% of the network token pays the 1% tier price', nameOf(r.provider) === 'Halo Compute' && haloTrip.off === 3_500 && r.cost === usd(holderCost) && holderCost < listCost,
  `$${r.cost} instead of $${usd(listCost)} · holds ${standing ? sharePct(standing) : '?'} of supply`);

await nodes[0].close();
r = await ask('llama-3.3-70b:cheap');
check('when the cheapest provider goes dark the request falls through', r.status === 200 && nameOf(r.provider) !== 'Kestrel GPU Co-op', `${nameOf(r.provider)} answered`);
const trips = router.trips;
const am = await fetch(`${ROUTER}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'any' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 64, system: 'Be brief.', messages: [{ role: 'user', content: 'Say hello.' }] }) });
const amj = (await am.json()) as { type?: string; content?: { type: string; text?: string }[]; stop_reason?: string; usage?: { input_tokens: number; output_tokens: number } };
check('/v1/messages answers in the Anthropic shape', am.status === 200 && amj.type === 'message' && amj.content?.[0]?.type === 'text' && (amj.content[0].text ?? '').length > 5 && (amj.usage?.output_tokens ?? 0) > 0, `${amj.stop_reason} · ${amj.usage?.input_tokens}+${amj.usage?.output_tokens} tok`);
const as = await fetch(`${ROUTER}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v3', max_tokens: 64, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }] }) });
const raw = await as.text();
const evs = [...raw.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
const streamed = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((d) => d.delta?.type === 'text_delta').map((d) => d.delta.text).join('');
check('/v1/messages streams message_start … message_stop', as.status === 200 && evs[0] === 'message_start' && evs.at(-1) === 'message_stop' && evs.includes('content_block_delta') && streamed.length > 5, `${evs.length} events, ${streamed.length} chars`);
const al = await fetch(`${ROUTER}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const alj = (await al.json()) as { model?: string; content?: { text?: string }[] };
check('an alias answers an Anthropic model name with a network model', al.status === 200 && alj.model === 'llama-3.3-70b' && (alj.content?.[0]?.text ?? '').length > 5, `claude-sonnet-4-5 → ${alj.model}`);
const rs = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', stream: true, max_tokens: 64, messages: [{ role: 'user', content: '[die-mid] Say hello.' }] }) });
const rsText = (await rs.text()).split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean).flatMap((d) => d.choices ?? []).map((c: { delta?: { content?: string } }) => c.delta?.content ?? '').join('');
const rsTrip = router.trips[router.trips.length - 1];
check('a stream dropped mid-answer is resumed by the next provider', rsText === 'Requests travel from your computer to a provider and back; the router signs a running total and the provider redeems it on Solana.' && rsTrip?.resumed === true, `${rsText.length} chars, finished by ${rsTrip?.providerName}`);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const ra = await fetch(`${ROUTER}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '[die-mid] Say hello.' }] }) });
const raRaw = await ra.text();
const raEvents = [...raRaw.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
const raText = raRaw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((d) => d.delta?.type === 'text_delta').map((d) => d.delta.text).join('');
check('an Anthropic stream resumes inside the same message', raText === 'Requests travel from your computer to a provider and back; the router signs a running total and the provider redeems it on Solana.' && raEvents.filter((e) => e === 'message_start').length === 1 && raEvents.at(-1) === 'message_stop', `${raEvents.length} events, one message`);
const mcp = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'mcp', '--router', ROUTER], { stdio: ['pipe', 'pipe', 'ignore'] });
procs.push(mcp);
const mcpOut: Record<number, { result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] } }> = {};
let mcpBuf = '';
mcp.stdout!.on('data', (d) => { mcpBuf += d.toString(); let i; while ((i = mcpBuf.indexOf('\n')) >= 0) { const line = mcpBuf.slice(0, i); mcpBuf = mcpBuf.slice(i + 1); try { const m = JSON.parse(line); if (m.id !== undefined) mcpOut[m.id] = m; } catch { } } });
const mcpSend = (o: unknown) => mcp.stdin!.write(`${JSON.stringify(o)}\n`);
mcpSend({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rehearsal', version: '0' } } });
mcpSend({ jsonrpc: '2.0', method: 'notifications/initialized' });
mcpSend({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
mcpSend({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask', arguments: { model: 'llama-3.3-70b', prompt: 'Say hello.', max_tokens: 64 } } });
for (let i = 0; i < 100 && !mcpOut[3]; i++) await sleep(200);
const mcpAnswer = mcpOut[3]?.result?.content?.[0]?.text ?? '';
check('an agent asks the network through orrery mcp and the answer is paid', (mcpOut[2]?.result?.tools ?? []).map((t) => t.name).join(',') === 'ask,models,status' && !mcpOut[3]?.result?.isError && mcpAnswer.startsWith('Requests travel') && /paid \$0\.0000\d+ for this answer/.test(mcpAnswer), mcpAnswer.split('\n').pop() ?? '');
mcp.kill();
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const rr = await fetch(`${ROUTER}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', instructions: 'Be brief.', input: 'Say hello.', max_output_tokens: 64 }) });
const rrj = (await rr.json()) as { object?: string; status?: string; output?: { content?: { text?: string }[] }[]; usage?: { output_tokens: number } };
check('/v1/responses answers as a response object', rr.status === 200 && rrj.object === 'response' && rrj.status === 'completed' && (rrj.output?.[0]?.content?.[0]?.text ?? '').length > 5, `${rrj.status} · ${rrj.usage?.output_tokens} output tokens`);
const rst = await fetch(`${ROUTER}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v3', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] }], stream: true, max_output_tokens: 64 }) });
const rstRaw = await rst.text();
const rstEv = [...rstRaw.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
const rstText = rstRaw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((d) => d.type === 'response.output_text.delta').map((d) => d.delta).join('');
check('/v1/responses streams response.created … response.completed', rst.status === 200 && rstEv[0] === 'response.created' && rstEv.at(-1) === 'response.completed' && rstText.length > 5, `${rstEv.length} events`);
check('router logged every answered request', trips.length === 22, `${trips.length} trips`);

console.log('\nsettlement');
const redeemTx: Record<string, string> = {};
for (const n of nodes) for (const d of await n.redeemDue(1n)) redeemTx[n.pda.toBase58()] = d.tx;
const signed = Object.fromEntries(channels.list().map((c) => [c.provider, { channel: c.channel, cumulative: c.cumulative.toString(), usageHash: c.usageHash.toString('hex'), voucher: c.voucher }]));
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
check('no fee in the program: user + providers + open deposits = 100 USDC', userNow + paidTotal + inVaults === 100n * USD, `user $${usd(userNow, 4)} · providers $${usd(paidTotal, 4)} · deposits $${usd(inVaults, 4)}`);
const cfg = decodeConfig((await conn.getAccountInfo(pda.config()))!.data);
check('program totals agree', cfg.settled === paidTotal && cfg.providers === BigInt(providerSpecs.length) && cfg.bondMint.equals(orey), `settled $${usd(cfg.settled)} · ${cfg.channels} channels`);

console.log('\nmany channels');
const vaultNode = nodes[2];
const extraChannels: string[] = [];
for (let i = 0; i < 3; i++) {
  const w = Keypair.generate();
  await fund(w.publicKey, 2);
  const ata = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, w.publicKey);
  await mintTo(conn, admin, usdc, ata.address, admin, USD);
  const c = new Channels(conn, w, Keypair.generate(), usdc, join(WORK, `home/extra-${i}.json`), { deposit: USD / 10n, topUpBelow: 0n, dailyCap: USD });
  const st = await c.ensure(vaultNode.pda.toBase58(), 1n);
  const v = c.settle(vaultNode.pda.toBase58(), { requestId: `extra-${i}`, model: 'qwen3-32b', inputTokens: 1, outputTokens: 1, cost: 5n });
  await fetch('http://127.0.0.1:17283/orrery/voucher', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: st.channel, voucher: v }) });
  extraChannels.push(st.channel);
}
await sendAndConfirmTransaction(conn, new Transaction().add(ins.closeChannel(vaultNode.node.publicKey, wallets[2].publicKey, new PublicKey(extraChannels[0]), (decodeChannel((await conn.getAccountInfo(new PublicKey(extraChannels[0])))!.data)).payer, usdc)), [vaultNode.node]);
const extraRedeemed = await vaultNode.redeemDue(1n);
check('a provider with many channels redeems them in transactions that fit, skipping one that closed', extraRedeemed.length === 2 && extraRedeemed.every((d) => d.amount === 5n) && new Set(extraRedeemed.map((d) => d.tx)).size === 1, `${extraRedeemed.length} channels in ${new Set(extraRedeemed.map((d) => d.tx)).size} tx`);

const summary = {
  ranAt: new Date().toISOString(), program: PROGRAM_ID, requests: trips.length, settledUnits: paidTotal.toString(),
  trips: trips.map((t) => ({ route: t.route, model: t.model, provider: t.providerName, tokens: `${t.inputTokens}+${t.outputTokens}`, cost: t.cost, ttftMs: t.ttftMs, sealed: t.sealed, fellThrough: t.fellThrough, holderOff: t.off })),
  holder: { mint: orey.toBase58(), tiers: HOLDER_TIERS, userShare: standing ? sharePct(standing) : null, listCost: listCost.toString(), paidCost: holderCost.toString() },
  providers: providerSpecs.map((s, i) => ({
    name: s.name, region: s.region, enclave: s.tee, holderTiers: 'holder' in s, address: nodes[i].pda.toBase58(),
    models: s.models.map(([id, input, output]) => ({ id, input, output })),
    ...(signed[nodes[i].pda.toBase58()] ?? {}), redeemTx: redeemTx[nodes[i].pda.toBase58()] ?? null,
  })),
  balances: { user: userNow.toString(), providers: paidTotal.toString(), deposits: inVaults.toString() },
  session: session.publicKey.toBase58(),
  checks,
};
writeFileSync(join(WORK, 'summary.json'), JSON.stringify(summary, null, 2));
await router.close();
for (const n of nodes.slice(1)) await n.close();
for (const p of procs) p.kill('SIGTERM');
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
