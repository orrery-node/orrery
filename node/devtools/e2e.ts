// End to end on a local validator: the real program, four provider nodes in front of mock models, the router, a
// dozen requests on every route, holder pricing for a wallet that holds the network token, a provider going dark
// mid-run, on-chain redemption, a provider releasing its channel, and a final check that every unit of USDC is where
// it should be.
//   cd node && npx tsx devtools/e2e.ts     (needs program/target/deploy/orrery.so: anchor build --arch v2)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  { name: 'Ironbridge Compute', region: 'us-east', port: 17282, up: 19102, tee: false, resume: true, models: [['llama-3.3-70b', 200_000, 450_000], ['deepseek-v3', 270_000, 1_100_000], ['gpt-oss-120b', 37_500, 140_000, 9_375]] },
  { name: 'Vault Nine', region: 'eu-west', port: 17283, up: 19103, tee: true, resume: true, models: [['llama-3.3-70b', 250_000, 600_000], ['qwen3-32b', 150_000, 300_000], ['gpt-oss-120b', 35_000, 140_000]] },
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
    models: s.models.map((m) => { const [id, input, output, cachedInput] = m as readonly [string, number, number, number?]; return { id, context: 131_072, maxOutput: 4_096, price: { input, output, ...(cachedInput ? { cachedInput } : {}) } }; }),
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
check('/v1/models lists the network catalog, with a cached-input price where one is listed', models.data.length === 5 && models.data.find((m: { id: string }) => m.id === 'gpt-oss-120b')?.pricing?.cached_prompt_per_million === 0.009375, models.data.map((m: { id: string; providers: number }) => `${m.id}×${m.providers}`).join(' '));

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
mcpSend({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'models', arguments: {} } });
mcpSend({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask', arguments: { model: 'deepseek-v3', prompt: 'Say hello.', max_tokens: 32, max_price: '0.20/1.00' } } });
for (let i = 0; i < 100 && !(mcpOut[3] && mcpOut[4] && mcpOut[5]); i++) await sleep(200);
mcpSend({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: {} } });
for (let i = 0; i < 50 && !mcpOut[6]; i++) await sleep(200);
const mcpAnswer = mcpOut[3]?.result?.content?.[0]?.text ?? '';
check('an agent asks the network through orrery mcp and the answer is paid', (mcpOut[2]?.result?.tools ?? []).map((t) => t.name).join(',') === 'ask,models,status' && !mcpOut[3]?.result?.isError && mcpAnswer.startsWith('Requests travel') && /paid \$0\.0000\d+ for this answer/.test(mcpAnswer), mcpAnswer.split('\n').pop() ?? '');
const mcpModels = mcpOut[4]?.result?.content?.[0]?.text ?? '';
const mcpCapped = mcpOut[5]?.result?.content?.[0]?.text ?? '';
const mcpStatus = mcpOut[6]?.result?.content?.[0]?.text ?? '';
check('an agent reads its own last 24 hours of spend by model through orrery mcp', /last 24h by model:\n[\s\S]*answer/.test(mcpStatus), mcpStatus.split('\n').slice(-2).join(' · '));
check('an agent sees on-chain prices, cached ones included, and caps what one ask may cost', /gpt-oss-120b .*cached in from \$0\.0094/.test(mcpModels) && mcpOut[5]?.result?.isError === true && mcpCapped.includes('price ceiling'), `${mcpModels.split('\n').find((l: string) => l.startsWith('gpt-oss-120b')) ?? ''} · capped ask: ${mcpCapped.slice(0, 90)}`);
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
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const agentSystem = 'You are a careful coding agent working in this repository. '.repeat(64);
const cachedAsk = async () => {
  const res = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-oss-120b:cheap', messages: [{ role: 'system', content: agentSystem }, { role: 'user', content: 'Say hello.' }], max_tokens: 32 }) });
  const text = await res.text();
  return { cost: res.headers.get('x-orrery-cost') ?? '', trip: trips.at(-1)!, status: res.status, text };
};
const vaultAddr = nodes[2].pda.toBase58();
const vaultObs = router.stats.get(vaultAddr);
router.stats.all().set(vaultAddr, { ...vaultObs, cooldownUntil: Date.now() + 60_000 });
const turn1 = await cachedAsk();
router.stats.all().set(vaultAddr, { ...router.stats.get(vaultAddr), cooldownUntil: 0 });
const turn2 = await cachedAsk();
const cachedPrice = { input: 37_500, output: 140_000, cachedInput: 9_375 };
const cachedN = Math.floor(JSON.stringify({ role: 'system', content: agentSystem }).length / 4);
const full1 = costOf(cachedPrice, turn1.trip.inputTokens, turn1.trip.outputTokens);
const hit2 = costOf(cachedPrice, turn2.trip.inputTokens, turn2.trip.outputTokens, cachedN);
check('a repeated agent prompt stays with the provider holding its cache and is billed at its cached-input price', turn1.trip.providerName === 'Ironbridge Compute' && turn2.trip.providerName === 'Ironbridge Compute' && !turn1.trip.cacheKept && turn2.trip.cacheKept === true && turn1.cost === usd(full1) && turn2.cost === usd(hit2) && hit2 < full1, turn2.cost ? `$${turn1.cost} → $${turn2.cost} · ${cachedN} of ${turn2.trip.inputTokens} input tokens cached · price route, turn 2 went to ${turn2.trip.providerName} (Vault Nine lists less)` : `${turn1.status} ${turn1.text.slice(0, 200)}`);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const capped = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-max-price': '0.15/0.60' }, body: JSON.stringify({ model: 'gemma-3-27b', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 32 }) });
await capped.text();
const overCap = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-max-price': '0.20/1.00' }, body: JSON.stringify({ model: 'deepseek-v3', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 32 }) });
const overCapJ = (await overCap.json()) as { error?: { code?: string; message?: string } };
check('a price ceiling keeps the router under it, counting the holder discount, and says so when nothing fits', capped.status === 200 && nameOf(capped.headers.get('x-orrery-provider')) === 'Halo Compute' && overCap.status === 404 && overCapJ.error?.code === 'over_price_ceiling', `gemma under $0.15/$0.60 → ${nameOf(capped.headers.get('x-orrery-provider'))} (lists $0.20/$0.80, holder −35%) · deepseek under $0.20/$1.00 → ${overCap.status} ${overCapJ.error?.code}: ${overCapJ.error?.message}`);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const fb1 = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'no-such-model|llama-3.3-70b', messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 32 }) });
const fb1j = (await fb1.json()) as { model?: string };
const fb2 = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-max-price': '0.20/1.00' }, body: JSON.stringify({ models: ['deepseek-v3', 'qwen3-32b'], messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 32 }) });
const fb2j = (await fb2.json()) as { model?: string };
check('a request with fallbacks moves to the next model when the first cannot be served', fb1.status === 200 && fb1j.model === 'llama-3.3-70b' && fb2.status === 200 && fb2j.model === 'qwen3-32b', `no-such-model|llama-3.3-70b → ${fb1j.model} · [deepseek-v3, qwen3-32b] under $0.20/$1.00 → ${fb2j.model} via ${nameOf(fb2.headers.get('x-orrery-provider'))}`);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const { bench, renderBench } = await import('../src/bench.ts');
const benchFrom = trips.length;
const benchRows = await bench({ model: 'llama-3.3-70b', providers: registry.usable().filter((e) => e.manifest!.models.some((m) => m.id === 'llama-3.3-70b')), router: ROUTER, n: 3 });
writeFileSync(join(WORK, 'bench.txt'), renderBench('llama-3.3-70b', benchRows));
const benchSpent = benchRows.flatMap((r) => r.units).reduce((a, b) => a + b, 0n);
const benchTrips = trips.slice(benchFrom).reduce((a, t) => a + BigInt(Math.round(Number(t.cost) * 1e6)), 0n);
const byName = Object.fromEntries(benchRows.map((r) => [r.name, `${r.answered}/${r.asked}`]));
check('orrery bench asks each provider of a model through the router and adds up to what it paid', byName['Ironbridge Compute'] === '3/3' && byName['Vault Nine'] === '3/3' && byName['Kestrel GPU Co-op'] === '0/1' && benchSpent === benchTrips && benchSpent > 0n, `${Object.entries(byName).map(([k, v]) => `${k} ${v}`).join(', ')} · spent $${usd(benchSpent)}`);
let codexTrips = 0;
if (process.env.E2E_CODEX) {
  const codexHome = join(WORK, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), 'approval_policy = "never"\n');
  await new Promise<void>((done) => { const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'connect', 'codex', '--write', '--model', 'llama-3.3-70b', '--router', ROUTER], { stdio: 'ignore', env: { ...process.env, CODEX_HOME: codexHome } }); pc.on('exit', () => done()); });
  for (const o of router.stats.all().values()) o.cooldownUntil = 0;
  const before = trips.length;
  const version = process.env.E2E_CODEX === '1' ? '0.167.0' : process.env.E2E_CODEX;
  const cx = await new Promise<{ code: number | null; out: string }>((done) => {
    let out = '';
    const p = spawn('npx', ['-y', `@openai/codex@${version}`, 'exec', '--profile', 'orrery', '--skip-git-repo-check', '--sandbox', 'read-only', 'Say hello in one short sentence.'], { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome } });
    p.stdout!.on('data', (d) => (out += d));
    p.stderr!.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill('SIGTERM'), 180_000);
    p.on('exit', (code) => { clearTimeout(timer); done({ code, out }); });
  });
  writeFileSync(join(WORK, 'codex.log'), cx.out);
  codexTrips = trips.length - before;
  const profile = readFileSync(join(codexHome, 'orrery.config.toml'), 'utf8');
  const ctxLine = profile.match(/^model_context_window = (\d+)$/m)?.[1];
  check(`orrery connect codex writes a profile and Codex CLI ${version} runs through the router`, cx.code === 0 && cx.out.includes('Requests travel') && codexTrips >= 1 && Number(ctxLine) > 0, `exit ${cx.code} · ${codexTrips} paid request(s) · context window ${ctxLine ?? 'missing'}${cx.out.includes('metadata') ? ' · codex warns: no built-in metadata' : ''}`);
}
let claudeTrips = 0;
if (process.env.E2E_CLAUDE) {
  const cfgDir = join(WORK, 'claude-home');
  mkdirSync(cfgDir, { recursive: true });
  for (const o of router.stats.all().values()) o.cooldownUntil = 0;
  const before = trips.length;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ANTHROPIC')));
  const cc = await new Promise<{ code: number | null; out: string }>((done) => {
    let out = '';
    const p = spawn(process.env.E2E_CLAUDE === '1' ? 'claude' : process.env.E2E_CLAUDE!, ['-p', 'Say hello in one short sentence.', '--model', 'claude-sonnet-4-5'], { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, CLAUDE_CONFIG_DIR: cfgDir, ANTHROPIC_BASE_URL: ROUTER, ANTHROPIC_API_KEY: 'orrery', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    p.stdout!.on('data', (d) => (out += d));
    p.stderr!.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill('SIGTERM'), 180_000);
    p.on('exit', (code) => { clearTimeout(timer); done({ code, out }); });
  });
  writeFileSync(join(WORK, 'claude.log'), cc.out);
  claudeTrips = trips.length - before;
  check('Claude Code runs through the router on the Anthropic API, claude-* answered by a network model', cc.code === 0 && cc.out.includes('Requests travel') && claudeTrips >= 1, `exit ${cc.code} · ${claudeTrips} paid request(s)`);
}
const initOut = join(WORK, 'init-provider.json');
await new Promise<void>((done) => { const pi = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'init', '--upstream', 'http://127.0.0.1:19102/v1', '--name', 'Rehearsal Rig', '--out', initOut], { stdio: 'ignore' }); pi.on('exit', () => done()); });
const initCfg = existsSync(initOut) ? JSON.parse(readFileSync(initOut, 'utf8')) as { name: string; upstream: { baseUrl: string }; models: { id: string; upstreamModel: string }[] } : null;
check('orrery provider init finds a model server and writes provider.json', initCfg?.name === 'Rehearsal Rig' && initCfg.upstream.baseUrl === 'http://127.0.0.1:19102/v1' && initCfg.models.map((m) => m.id).join(',') === 'llama3.1-8b,qwen2.5-7b', initCfg ? initCfg.models.map((m) => `${m.upstreamModel} → ${m.id}`).join(', ') : 'no file');
const { doctor } = await import('../src/doctor.ts');
const doc = await doctor({ rpc: RPC, mint: usdc, wallet: user.publicKey, router: ROUTER, deposit: USD });
const docBad = doc.filter((l) => l.ok === false).map((l) => l.what.trim());
check('orrery doctor reads the chain, every listing, the wallet and the router, and flags the provider that went dark', docBad.length === 1 && docBad[0] === nodes[0].pda.toBase58().slice(0, 8) && doc.some((l) => l.what === 'router' && l.ok) && doc.some((l) => l.what === 'wallet USDC' && l.ok), `${doc.filter((l) => l.ok).length} ok · flagged: ${docBad.join(', ') || 'none'} (Kestrel, dark: ${doc.find((l) => l.ok === false)?.detail ?? ''})`);
let loadTrips = 0;
if (process.env.E2E_LOAD) {
  const n = Number(process.env.E2E_LOAD), conc = Number(process.env.E2E_LOAD_CONC ?? 1);
  for (const o of router.stats.all().values()) o.cooldownUntil = 0;
  const before = trips.length;
  const models = ['llama-3.3-70b', 'deepseek-v3', 'qwen3-32b', 'gemma-3-27b', 'gpt-oss-120b'];
  let next = 0, ok = 0;
  const errors: string[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < n) {
      const i = next++;
      const res = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: models[i % models.length], messages: [{ role: 'user', content: `Question ${i}: say hello.` }], max_tokens: 32 }) });
      const text = await res.text();
      if (res.ok) ok++;
      else errors.push(`${res.status} ${text.slice(0, 120)}`);
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  loadTrips = trips.length - before;
  const per = new Map<string, number>();
  for (const t of trips.slice(before)) per.set(t.providerName, (per.get(t.providerName) ?? 0) + 1);
  check(`${n} answers through the router, ${conc} at a time`, ok === n && errors.length === 0 && loadTrips === n, `${ok} ok · ${errors.length} failed · ${(n / secs).toFixed(1)} answers/s · ${[...per].map(([k, v]) => `${k} ${v}`).join(', ')}${errors.length ? ` · first error: ${errors[0]}` : ''}`);
}
const { readTrips, summarize } = await import('../src/spend.ts');
const logged = summarize(readTrips(join(WORK, 'home/router/trips.jsonl')), 'model', Infinity);
const signedAll = channels.list().reduce((a, c) => a + c.cumulative, 0n);
const servedUnits = providerSpecs.map((ps) => summarize(readTrips(join(WORK, 'providers', ps.name.split(' ')[0].toLowerCase(), 'served.jsonl')), 'model', Infinity).total).reduce((a, t) => ({ answers: a.answers + t.answers, units: a.units + t.units }), { answers: 0, units: 0n });
check('every provider’s own log of what it billed adds up to what the router signed', servedUnits.answers === trips.length && servedUnits.units === signedAll, `${servedUnits.answers} answers billed across 4 providers · $${usd(servedUnits.units)} billed · $${usd(signedAll)} signed`);
check('orrery spend adds up to exactly what the router signed across its channels', logged.total.answers === trips.length && logged.total.units === signedAll, `${logged.total.answers} answers · $${usd(logged.total.units)} logged · $${usd(signedAll)} signed`);
check('router logged every answered request', trips.length === 33 + codexTrips + claudeTrips + loadTrips, `${trips.length} trips`);

const ib = nodes[1];
const ibStatus = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/status`)).json()) as { answers: number; signed: string; waiting: string; channels: { signed: string }[] };
const ibSigned = channels.get(ib.pda.toBase58())?.cumulative ?? 0n;
const relayed = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/status`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
check('the provider console shows what routers signed to it, and only on its own computer', ibStatus.signed === usd(ibSigned) && ibStatus.waiting === usd(ibSigned) && ibStatus.answers > 0 && relayed.status === 404, `Ironbridge: ${ibStatus.answers} answers · $${ibStatus.signed} signed · $${ibStatus.waiting} waiting · relayed request ${relayed.status}`);
if (process.env.E2E_HOLD) {
  console.log(`holding the network for ${process.env.E2E_HOLD}s before settlement: router console at ${ROUTER}/`);
  await sleep(Number(process.env.E2E_HOLD) * 1000);
}
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
