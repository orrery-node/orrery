// End to end on a local validator: the real program, four provider nodes in front of mock models, the router, a
// dozen requests on every route, holder pricing for a wallet that holds the network token, a provider going dark
// mid-run, on-chain redemption, a provider releasing its channel, and a final check that every unit of USDC is where
// it should be.
//   cd node && npx tsx devtools/e2e.ts     (needs program/target/deploy/orrery.so: anchor build --arch v2)
import { readPayouts } from '../src/provider/payouts.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { rpcConnection } from '../src/chain/connect.ts';
import { sendOne } from '../src/chain/send.ts';
import { parseProxy, setNodeProxy } from '../src/proxy.ts';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, createTransferInstruction } from '@solana/spl-token';

const ROOT = new URL('../../', import.meta.url).pathname;
const WORK = join(ROOT, '.local/e2e');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.env.ORRERY_HOME = join(WORK, 'home');

const { PROGRAM_ID } = await import('../src/brand.ts');
const { ACCOUNT, decodeChannel, decodeConfig, decodeProvider, ins, pda } = await import('../src/chain/program.ts');
const { splBurner } = await import('../src/burn.ts');
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
const mockOf: Record<string, ChildProcess> = {};
for (const [port, delay, label] of upstreams) {
  // Ironbridge's model server serves 131,072 tokens of context, what its listings say, and refuses past it as vLLM does.
  const m = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/devtools/mock-upstream.ts'), String(port), String(delay), label], { stdio: 'ignore', env: label === 'ironbridge' ? { ...process.env, MOCK_MAX_MODEL_LEN: '131072' } : process.env });
  mockOf[label] = m;
  procs.push(m);
}
await sleep(1_500);

// A chat webhook for one node's payout notices: Kestrel posts each payout's arrival here, as an operator's Slack would get it.
const hooked: { path: string; body: { text?: string; content?: string; payout?: Record<string, string | null> | null } }[] = [];
const hookServer = createHttpServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    try {
      hooked.push({ path: req.url ?? '', body: JSON.parse(b) });
    } catch {
      hooked.push({ path: req.url ?? '', body: {} });
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
});
await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', () => r()));
hookServer.unref();
const HOOK = `http://127.0.0.1:${(hookServer.address() as { port: number }).port}/hooks/kestrel`;

const providerSpecs = [
  { name: 'Kestrel GPU Co-op', region: 'eu-north', port: 17281, up: 19101, tee: false, models: [['llama-3.3-70b', 120_000, 300_000], ['qwen3-32b', 80_000, 200_000]] },
  { name: 'Ironbridge Compute', region: 'us-east', port: 17282, up: 19102, tee: false, resume: true, burn: 2_500, models: [['llama-3.3-70b', 200_000, 450_000], ['deepseek-v3', 270_000, 1_100_000], ['gpt-oss-120b', 37_500, 140_000, 9_375], ['bge-m3', 20_000, 0]] },
  { name: 'Vault Nine', region: 'eu-west', port: 17283, up: 19103, tee: true, resume: true, models: [['llama-3.3-70b', 250_000, 600_000], ['qwen3-32b', 150_000, 300_000], ['gpt-oss-120b', 35_000, 140_000]] },
  { name: 'Halo Compute', region: 'ap-northeast', port: 17284, up: 19104, tee: false, holder: true, inside: true, models: [['gemma-3-27b', 200_000, 800_000]] },
] as const;

const nodes: InstanceType<typeof ProviderNode>[] = [];
const wallets: Keypair[] = [];
const nodeSaid: string[][] = [];
for (const s of providerSpecs) {
  const wallet = Keypair.generate();
  wallets.push(wallet);
  const dir = join(WORK, 'providers', s.name.split(' ')[0].toLowerCase());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'wallet.json'), JSON.stringify(Array.from(wallet.secretKey)));
  const node = new ProviderNode({
    name: s.name, region: s.region, listen: s.port, host: '127.0.0.1', publicUrl: `http://127.0.0.1:${s.port}`, rpcUrl: RPC, settleMint: usdc.toBase58(),
    wallet: join(dir, 'wallet.json'), dataDir: dir, upstream: { baseUrl: `http://127.0.0.1:${s.up}/v1` },
    models: s.models.map((m) => { const [id, input, output, cachedInput] = m as readonly [string, number, number, number?]; return { id, context: s.name.startsWith('Kestrel') && id === 'qwen3-32b' ? 8_192 : 131_072, maxOutput: 4_096, price: { input, output, ...(cachedInput ? { cachedInput } : {}) } }; }),
    tee: s.tee ? { mode: 'dev', kind: 3 } : undefined, redeem: { everySecs: 3_600, minUnits: 1 }, resume: 'resume' in s ? s.resume : undefined,
    holder: 'holder' in s ? { tiers: HOLDER_TIERS } : undefined,
    burn: 'burn' in s ? { share: s.burn as number, minUnits: 1 } : undefined,
    paymentInside: 'inside' in s ? (s.inside as boolean) : undefined,
    notify: s.name.startsWith('Kestrel') ? { url: HOOK } : undefined,
  });
  const said: string[] = [];
  nodeSaid.push(said);
  node.log = (l) => {
    said.push(l);
    console.log(`    [${s.name.split(' ')[0]}] ${l}`);
  };
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
const WATCHED = join(WORK, 'home/router/watched.json');
const registry = new (Registry as unknown as new (...a: unknown[]) => InstanceType<typeof Registry>)(conn, { allowDev: true, measurements: [] }, undefined, WATCHED);
const channels = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
const OBSERVED = join(WORK, 'home/router/observed.json');
const router = new Router({ port: 17171, route: 'auto', minReputation: 0, registry, channels, conn, refreshSecs: 3_600, observedPath: OBSERVED, log: (l) => console.log(`    [router] ${l}`), holders: new HolderBook(conn, 60_000, undefined, { serveStale: true }), aliases: parseAliases('claude-*=llama-3.3-70b') });
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
  return { status: r.status, provider: r.headers.get('x-orrery-provider'), content: j.choices?.[0]?.message?.content ?? '', cost: r.headers.get('x-orrery-cost'), body: j, headers: r.headers };
};
const nameOf = (addr: string | null) => registry.get(addr ?? '')?.manifest?.name ?? addr;

console.log('\nrequests');
const models = await (await fetch(`${ROUTER}/v1/models`)).json();
check('/v1/models lists the network catalog, with a cached-input price where one is listed', models.data.length === 6 && models.data.find((m: { id: string }) => m.id === 'gpt-oss-120b')?.pricing?.cached_prompt_per_million === 0.009375, models.data.map((m: { id: string; providers: number }) => `${m.id}×${m.providers}`).join(' '));

// Kestrel lists qwen3-32b at 8,192 tokens of context and Vault Nine at 131,072. Kestrel is the cheaper, so a short
// prompt goes there; one clearly longer than 8,192 tokens goes to Vault Nine, and Kestrel is not counted against.
{
  const kestrel = nodes[0].pda.toBase58();
  const failsBefore = router.stats.get(kestrel)?.fail ?? 0;
  const short = await ask('qwen3-32b:cheap');
  const prompt = `${'The router signs a running total and the node redeems it on Solana. '.repeat(700)}In one sentence, what happens?`;
  const longR = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3-32b:cheap', max_tokens: 64, messages: [{ role: 'user', content: prompt }] }) });
  await longR.text();
  const failsAfter = router.stats.get(kestrel)?.fail ?? 0;
  check('a prompt longer than the context a node lists goes to a node that lists enough, and the node passed over is not counted against', nameOf(short.provider) === 'Kestrel GPU Co-op' && longR.status === 200 && nameOf(longR.headers.get('x-orrery-provider')) === 'Vault Nine' && !longR.headers.get('x-orrery-skipped') && failsAfter === failsBefore,
    `short prompt: ${nameOf(short.provider)} · ${prompt.length.toLocaleString('en-US')}-character prompt: ${nameOf(longR.headers.get('x-orrery-provider'))} (${longR.status}${longR.headers.get('x-orrery-skipped') ? `, skipped ${longR.headers.get('x-orrery-skipped')}` : ''}) · Kestrel failures ${failsBefore} → ${failsAfter}`);
}
// The same long prompt, sent where only Kestrel may answer: longer than any context on offer. The router says so in the
// error OpenAI and Anthropic clients already act on (an agent shortens its conversation), and asks no node.
{
  const kestrel = nodes[0].pda.toBase58();
  const failsBefore = router.stats.get(kestrel)?.fail ?? 0;
  const prompt = `${'The router signs a running total and the node redeems it on Solana. '.repeat(700)}In one sentence, what happens?`;
  const pinned = { 'content-type': 'application/json', 'x-orrery-provider': kestrel };
  const oa = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: pinned, body: JSON.stringify({ model: 'qwen3-32b', max_tokens: 64, messages: [{ role: 'user', content: prompt }] }) });
  const oaj = await oa.json().catch(() => ({}));
  const an = await fetch(`${ROUTER}/v1/messages`, { method: 'POST', headers: pinned, body: JSON.stringify({ model: 'qwen3-32b', max_tokens: 64, messages: [{ role: 'user', content: prompt }] }) });
  const anj = await an.json().catch(() => ({}));
  const failsAfter = router.stats.get(kestrel)?.fail ?? 0;
  check('a prompt longer than every context on offer gets the error OpenAI and Anthropic clients act on, and no node is asked', oa.status === 400 && oaj.error?.code === 'context_length_exceeded' && /maximum context length is 8192 tokens/.test(oaj.error?.message ?? '') && an.status === 400 && anj.type === 'error' && /^prompt is too long: \d+ tokens > 8192 maximum$/.test(anj.error?.message ?? '') && failsAfter === failsBefore,
    `chat/completions ${oa.status} ${oaj.error?.code ?? '-'} · messages ${an.status} "${(anj.error?.message ?? '').slice(0, 50)}" · Kestrel failures ${failsBefore} → ${failsAfter}`);
}
let r = await ask('llama-3.3-70b:cheap');
check('price route picks the cheapest llama', nameOf(r.provider) === 'Kestrel GPU Co-op' && r.content.length > 20, `${nameOf(r.provider)}, $${r.cost}`);
r = await ask('deepseek-v3', { stream: true });
check('streaming works and only Ironbridge has deepseek', nameOf(r.provider) === 'Ironbridge Compute' && r.content.includes('Solana'), `${r.content.slice(0, 40)}…`);
const usageNone = ((r as { raw?: string }).raw ?? '').split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
const su = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v3', stream: true, stream_options: { include_usage: true }, max_tokens: 64, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const suFrames = (await su.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
const suLast = suFrames[suFrames.length - 1];
const suTrip = router.trips[router.trips.length - 1];
const nsj = await ask('deepseek-v3');
check('a stream ends with the billed usage and its cost only when the client asks (stream_options.include_usage)',
  !usageNone.some((f) => f.usage !== undefined || !f.choices?.length) && suFrames.filter((f) => f.usage).length === 1 && suLast.choices?.length === 0 && suLast.usage.prompt_tokens === suTrip.inputTokens && suLast.usage.completion_tokens === suTrip.outputTokens && suLast.usage.cost === Number(suTrip.cost) && (nsj as { body?: { usage?: { cost?: number } } }).body?.usage?.cost === Number((nsj as { cost?: string }).cost),
  `${suLast.usage?.prompt_tokens}+${suLast.usage?.completion_tokens} tok, cost ${suLast.usage?.cost} = signed $${suTrip.cost}; without the option, no usage chunk`);
r = await ask('qwen3-32b:private');
check('privacy route seals the request to the only enclave', nameOf(r.provider) === 'Vault Nine' && r.content.length > 20);
const sealedLogged = readFileSync(join(process.env.ORRERY_HOME!, 'router', 'trips.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { sealed?: boolean; enclave?: { kind: string; verdict: string } }).filter((t) => t.sealed).pop();
check('a sealed answer names the enclave the router verified before it encrypted the prompt, in its headers and in the router’s log on disk', sealedLogged?.enclave?.kind === 'Intel TDX + NVIDIA CC' && /dev report accepted/.test(sealedLogged.enclave.verdict) && r.headers?.get('x-orrery-sealed') === '1' && r.headers.get('x-orrery-enclave') === 'Intel TDX + NVIDIA CC' && /^[0-9a-f]{32}$/.test(r.headers.get('x-orrery-enclave-image') ?? '') && /dev report accepted/.test(r.headers.get('x-orrery-enclave-verdict') ?? ''), `x-orrery-enclave: ${r.headers?.get('x-orrery-enclave')} · image ${r.headers?.get('x-orrery-enclave-image')} · ${r.headers?.get('x-orrery-enclave-verdict')}`);
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

const kestrelSignedBefore = channels.get(nodes[0].pda.toBase58())?.cumulative ?? 0n;
await nodes[0].close();
r = await ask('llama-3.3-70b:cheap');
check('when the cheapest provider goes dark the request falls through', r.status === 200 && nameOf(r.provider) !== 'Kestrel GPU Co-op', `${nameOf(r.provider)} answered`);
// The answer says a node failed first, and the node that failed was signed nothing for it.
const kestrelSignedAfter = channels.get(nodes[0].pda.toBase58())?.cumulative ?? 0n;
check('an answer that came after a node failed says so, and the node that failed is signed nothing for it', r.headers?.get('x-orrery-skipped') === '1' && kestrelSignedAfter === kestrelSignedBefore && Number(r.cost) > 0, `x-orrery-skipped: ${r.headers?.get('x-orrery-skipped') ?? 'not said'} · signed to Kestrel before and after: $${usd(kestrelSignedBefore)} → $${usd(kestrelSignedAfter)} · ${nameOf(r.provider)} was paid $${r.cost}`);
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
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
mcpSend({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: {} } });
mcpSend({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'embed', arguments: { model: 'bge-m3', input: ['hello', 'world'] } } });
mcpSend({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'quote', arguments: { model: 'llama-3.3-70b', input_tokens: 2000, output_tokens: 400 } } });
mcpSend({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'ask', arguments: { model: 'llama-3.3-70b', prompt: 'Say hello.', max_tokens: 16, task: 'rehearsal-mcp', task_budget: 0.001 } } });
for (let i = 0; i < 50 && !(mcpOut[6] && mcpOut[7] && mcpOut[8] && mcpOut[9]); i++) await sleep(200);
mcpSend({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'status', arguments: {} } });
for (let i = 0; i < 50 && !mcpOut[10]; i++) await sleep(200);
// Embeddings under a task and from one node, named: the same as an ask, through the real router and the real server.
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
mcpSend({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'embed', arguments: { model: 'bge-m3', input: 'hello', task: 'rehearsal-embed', task_budget: 0.001, node: 'Ironbridge Compute' } } });
for (let i = 0; i < 50 && !mcpOut[11]; i++) await sleep(200);
mcpSend({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'status', arguments: {} } });
for (let i = 0; i < 50 && !mcpOut[12]; i++) await sleep(200);
const mcpEmbedTask = mcpOut[11]?.result?.content?.[0]?.text ?? '';
const mcpEmbedTrailer = mcpEmbedTask.slice(mcpEmbedTask.lastIndexOf('\n\n') + 2);
check('an agent embeds under a task and from one node through orrery mcp, and is told which node answered and what the task has left', /^— 1 vector of 8 dimensions, \d+ input tokens, paid \$0\.0000\d\d, answered by Ironbridge Compute \([^)]+\)\n— task rehearsal-embed: \$0\.0000\d\d spent, \$0\.000\d{3} left$/.test(mcpEmbedTrailer) && /rehearsal-embed: \$0\.0000\d\d of \$0\.001000 spent, \$0\.000\d{3} left, 1 answer/.test(mcpOut[12]?.result?.content?.[0]?.text ?? ''),
  mcpEmbedTrailer.replace(/\([^)]+\)/, '(…)').replace(/\n/g, ' ').slice(0, 170) || 'no answer');
const mcpTask = mcpOut[9]?.result?.content?.[0]?.text ?? '';
// That ask was capped at 16 tokens and the model server cut its reply there: the agent is told, not left guessing.
check('an agent is told through orrery mcp when an answer was cut off at its max_tokens', /\n— stopped at max_tokens 16, so the answer is cut off: ask with a larger max_tokens for all of it/.test(mcpTask), (mcpTask.split('\n').find((l) => /max_tokens/.test(l)) ?? 'the tool says nothing about it').slice(0, 120));
const mcpTasks = mcpOut[10]?.result?.content?.[0]?.text ?? '';
check('an agent working under a task through orrery mcp is told what the task has spent and has left, after each answer and in status', /— task rehearsal-mcp: \$0\.0000\d\d spent, \$0\.000\d{3} left$/.test(mcpTask) && /\ntasks:\n[\s\S]*rehearsal-mcp: \$0\.0000\d\d of \$0\.001000 spent, \$0\.000\d{3} left, 1 answer/.test(mcpTasks), `${mcpTask.split('\n').pop()} · ${mcpTasks.split('\n').find((l) => l.startsWith('rehearsal-mcp')) ?? 'no tasks in status'}`);
const mcpAnswer = mcpOut[3]?.result?.content?.[0]?.text ?? '';
check('an agent is told through orrery mcp how what it paid compares with the prices the node listed on chain', /paid \$\d\.\d{6} for this answer(, what its listed prices come to|, under its listed \$\d\.\d{6}| \(it asked)/.test(mcpAnswer), (mcpAnswer.split('\n').find((l) => l.includes('paid $')) ?? 'no paid line').replace(/\(([1-9A-HJ-NP-Za-km-z]{6})…\)/, '($1…)').slice(0, 150));
check('an agent asks the network through orrery mcp and the answer is paid', (mcpOut[2]?.result?.tools ?? []).map((t) => t.name).join(',') === 'ask,embed,quote,models,status' && !mcpOut[3]?.result?.isError && mcpAnswer.startsWith('Requests travel') && /paid \$0\.0000\d+ for this answer/.test(mcpAnswer), mcpAnswer.split('\n').pop() ?? '');
const mcpModels = mcpOut[4]?.result?.content?.[0]?.text ?? '';
const mcpCapped = mcpOut[5]?.result?.content?.[0]?.text ?? '';
const mcpStatus = mcpOut[6]?.result?.content?.[0]?.text ?? '';
const mcpEmbed = mcpOut[7]?.result?.content?.[0]?.text ?? '';
const mcpQuote = mcpOut[8]?.result?.content?.[0]?.text ?? '';
const quoteRows = mcpQuote.split('\n').filter((l) => /\$0\.\d{6}\s*/.test(l) && !l.startsWith('cheapest')).length;
check('an agent prices a job at every provider before paying, through orrery mcp', quoteRows >= 2 && /cheapest: .+, \$0\.\d{6} a request/.test(mcpQuote) && mcpQuote.includes('Nothing was sent or paid'), `${quoteRows} providers priced · ${(mcpQuote.split('\n').pop() ?? '').slice(0, 70)}`);
check('an agent gets embeddings from the network through orrery mcp, paid per call', /— 2 vectors of 8 dimensions, \d+ input tokens, paid \$0\.0000\d+/.test(mcpEmbed), mcpEmbed.split('\n').pop() ?? '');
check('an agent is told through orrery mcp how many of its answers came after a node did not answer, and that such a node is signed nothing', /\n\d+ of these answers came from the next node after another did not answer[^\n]*signed nothing\./.test(mcpStatus), mcpStatus.split('\n').find((l) => /did not answer/.test(l)) ?? 'status says nothing about them');
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
const budgetAsk = (cost: string) => fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-max-cost': cost }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const tight = await budgetAsk('0.000001');
const tightJ = (await tight.json()) as { error?: { code?: string; message?: string } };
const roomy = await budgetAsk('0.0005');
await roomy.json();
const roomyCost = Number(roomy.headers.get('x-orrery-cost'));
check('a dollar budget per request: only providers whose worst case fits are used, and a request that cannot fit is refused with the cheapest worst case', tight.status === 404 && tightJ.error?.code === 'over_budget' && /could cost up to \$0\.\d{6}/.test(tightJ.error?.message ?? '') && roomy.status === 200 && roomyCost > 0 && roomyCost <= 0.0005,
  `$0.000001 → ${tight.status} ${tightJ.error?.code} · $0.0005 → ${roomy.status}, paid $${roomy.headers.get('x-orrery-cost')} via ${nameOf(roomy.headers.get('x-orrery-provider'))}`);
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
const embFrom = trips.length;
const embRows = await bench({ model: 'bge-m3', providers: registry.usable().filter((e) => e.manifest!.models.some((m) => m.id === 'bge-m3')), router: ROUTER, n: 2 });
const embSpent = embRows.flatMap((r) => r.units).reduce((a, b) => a + b, 0n);
const embTrips = trips.slice(embFrom);
check('orrery bench asks an embedding model through /v1/embeddings', embRows.length === 1 && embRows[0].answered === 2 && embTrips.length === 2 && embTrips.every((t) => t.model === 'bge-m3' && t.outputTokens === 0) && embSpent === embTrips.reduce((a, t) => a + BigInt(Math.round(Number(t.cost) * 1e6)), 0n),
  `${embRows[0]?.name} ${embRows[0]?.answered}/${embRows[0]?.asked} · spent $${usd(embSpent)}`);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const embInput = ['Payment channels settle on Solana.', 'The router signs a running total.', 'A provider redeems whenever it likes.'];
const emb = await fetch(`${ROUTER}/v1/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'bge-m3', input: embInput }) });
const embj = (await emb.json()) as { data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens: number }; model?: string };
const embCost = emb.headers.get('x-orrery-cost');
const embExpected = costOf({ input: 20_000, output: 0 }, embj.usage?.prompt_tokens ?? 0, 0);
check('embeddings are routed and paid like any answer, priced on input tokens', emb.status === 200 && embj.model === 'bge-m3' && embj.data?.length === 3 && embj.data.every((d) => d.embedding.length === 8) && embCost === usd(embExpected) && trips.at(-1)?.model === 'bge-m3', `${embj.data?.length} vectors · ${embj.usage?.prompt_tokens} input tokens · $${embCost} via ${nameOf(emb.headers.get('x-orrery-provider'))}`);
const rawGet = (port: number, path: string, headers: Record<string, string>) => new Promise<number>((done) => {
  const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => { res.resume(); done(res.statusCode ?? 0); });
  r.on('error', () => done(0));
  r.end();
});
const rebindRouter = await rawGet(17171, '/orrery/status', { host: 'attacker.example:17171' });
const rebindProvider = await rawGet(providerSpecs[1].port, '/orrery/status', { host: 'attacker.example:' + providerSpecs[1].port });
const crossSite = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://attacker.example' }, body: JSON.stringify({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'Say hello.' }] }) });
const localOk = await rawGet(17171, '/orrery/status', { host: 'localhost:17171' });
check('a web page cannot spend through the router or read it by pointing a domain here', rebindRouter === 403 && rebindProvider === 404 && crossSite.status === 403 && localOk === 200, `rebinding: router ${rebindRouter}, provider console ${rebindProvider} · cross-site POST ${crossSite.status} · localhost ${localOk}`);
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
const docPaid = doc.find((l) => l.what.trim() === 'paid')?.detail ?? '';
check('orrery doctor says what the running router paid in the last 24 hours, and what it did not pay for', /^\$0\.\d{6} for \d+ answers in the last 24 h · \d+ of these answers came from the next node after another did not answer/.test(docPaid) && /signed nothing\.( · \d+ requests? got no answer from [^;]+; nothing was signed or paid for (it|them)\.)?$/.test(docPaid), docPaid.slice(0, 170) || 'doctor says nothing about it');
check('orrery doctor reads the chain, every listing, the wallet and the router, and flags the provider that went dark', docBad.length === 1 && docBad[0] === nodes[0].pda.toBase58().slice(0, 8) && doc.some((l) => l.what === 'router' && l.ok) && doc.some((l) => l.what === 'wallet USDC' && l.ok), `${doc.filter((l) => l.ok).length} ok · flagged: ${docBad.join(', ') || 'none'} (Kestrel, dark: ${doc.find((l) => l.ok === false)?.detail ?? ''})`);
// How a request and its payment travel to each node: doctor says, from the node's own signed answers.
const nodeLines = doc.filter((l) => /^  \S/.test(l.what) && l.ok === true);
const sealLines = doc.filter((l) => l.what.trim() === 'sealing');
check('orrery doctor says, for each node that answers, whether the request and the payment go sealed to it', nodeLines.length >= 2 && sealLines.length >= nodeLines.length && sealLines.every((l) => l.ok === true && /payment/.test(l.detail)), `${nodeLines.length} nodes answering, ${sealLines.length} sealing line${sealLines.length === 1 ? '' : 's'}${sealLines[0] ? `: ${sealLines[0].detail}` : ''}`);
// Which nodes list payment inside in their price list on chain, and so are kept to from a router's first request.
const sealUnder = (name: string) => doc.slice(doc.findIndex((l) => l.what.trim() === name) + 1).find((l) => l.what.trim() === 'sealing');
const haloSeal = sealUnder('Halo Compute'), ironSeal = sealUnder('Ironbridge Compute');
// A node's track record, as its own listing on chain counts it: how many times it has been paid out.
const ironDocLine = doc.find((l) => l.what.trim() === 'Ironbridge Compute');
const ironPayouts = Number(decodeProvider((await conn.getAccountInfo(nodes[1].pda))!.data).redeems);
check('orrery doctor says how many times each node has been paid out on chain', new RegExp(`paid out ${ironPayouts} times? on chain`).test(ironDocLine?.detail ?? ''), `Ironbridge: ${ironDocLine?.detail ?? 'no line'} · its listing counts ${ironPayouts}`);
check('orrery doctor says which nodes list payment inside in their price list on chain', /listed in its price list on chain/.test(haloSeal?.detail ?? '') && !/listed in its price list/.test(ironSeal?.detail ?? ''), `Halo: ${haloSeal?.detail ?? 'no line'} · Ironbridge: ${ironSeal?.detail ?? 'no line'}`);
// What a node sees of the caller: the node says, and doctor prints it, so a proxy can be checked from the far side.
const seenSaid = (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/v1/seen`).then((r) => r.json()).catch(() => ({}))) as { address?: string; socket?: string; forwarded?: string[] };
const seenLine = doc.find((l) => l.what === 'seen as');
// A node behind a balancer: what the balancer wrote down, as a hosting front would write it.
const fronted = (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/v1/seen`, { headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.20, 10.0.0.3' } }).then((r) => r.json())) as { address?: string; socket?: string; forwarded?: string[] };
check('a node behind a balancer tells a caller its public address and not the private addresses of its own network', fronted.address === '198.51.100.7' && fronted.socket === '' && JSON.stringify(fronted.forwarded) === JSON.stringify(['198.51.100.7', '203.0.113.20']), JSON.stringify(fronted));
check('a node says what address it sees a request from, and orrery doctor prints it, so a proxy is checked from the far side', seenSaid.address === '127.0.0.1' && seenSaid.socket === '127.0.0.1' && Array.isArray(seenSaid.forwarded) && seenSaid.forwarded.length === 0 && !!seenLine && /sees 127\.0\.0\.1/.test(seenLine.detail), seenLine?.detail ?? `no line from doctor · the node said ${JSON.stringify(seenSaid)}`);
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
// orrery channels, run against this router's home: every channel it paid through says what is unspent, which is the
// deposit on chain less what the router signed, and the last line adds those up.
const chOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'channels', '--rpc', RPC, '--mint', usdc.toBase58()], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const chLines = chOut.split('\n');
let chRight = 0, chSum = 0n;
for (const c of channels.list()) {
  const line = chLines.find((l) => l.startsWith(c.channel)) ?? '';
  const info = await conn.getAccountInfo(new PublicKey(c.channel));
  const unspent = info ? decodeChannel(info.data).deposit - c.cumulative : 0n;
  if (info && line.includes(`you signed $${usd(c.cumulative)}  unspent $${usd(unspent)}`)) chRight++;
}
for (const l of chLines) { const m = / unspent (?:up to )?\$(\d+\.\d{6})/.exec(l); if (m) chSum += BigInt(m[1].replace('.', '')); }
const chTotal = chLines.find((l) => l.startsWith('Unspent')) ?? '';
check('orrery channels says how much of each deposit is unspent, what closing it gives back, and adds it up', chRight === channels.list().filter((c) => chLines.some((l) => l.startsWith(c.channel) && !l.includes('closed'))).length && chRight > 0 && new RegExp(`^Unspent: (up to )?\\$${usd(chSum).replace('.', '\\.')} across \\d+ channels?\\.`).test(chTotal), `${chRight} channels right · ${chTotal.slice(0, 120) || chLines.slice(-1)[0]?.slice(0, 120)}`);
// What the router logged about nodes that did not answer, as orrery spend prints it: the count is the log's own.
const skippedLogged = readTrips(join(WORK, 'home/router/trips.jsonl')).filter((t) => (t.fellThrough ?? 0) > 0 && !(t as { resumed?: boolean }).resumed);
// Two streams in this run were dropped mid-answer and finished by another node: the log on disk says which.
const resumedLogged = readTrips(join(WORK, 'home/router/trips.jsonl')).filter((t) => (t as { resumed?: boolean }).resumed);
const spendOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'spend', '--since', '7d'], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const spendSkipLine = spendOut.split('\n').find((l) => /did not answer/.test(l)) ?? '';
check('orrery spend says how many answers came from the next node after another did not answer, and that such a node is signed nothing', skippedLogged.length > 0 && spendSkipLine.startsWith(`${skippedLogged.length} of these answers came from the next node after another did not answer`) && /signed nothing\.$/.test(spendSkipLine), spendSkipLine || `${skippedLogged.length} such answers in the log, and spend says nothing about them`);
check('the router’s log keeps which answers another node finished after the first stopped mid-answer, and orrery spend says so apart from nodes that did not answer', resumedLogged.length >= 2 && spendSkipLine.includes(`; ${resumedLogged.length} were finished by another node after the first stopped mid-answer. A node that does not answer or does not finish is signed nothing.`), `${resumedLogged.length} in the log · ${spendSkipLine.split('; ')[1] ?? 'spend says nothing about them'}`);
// orrery spend --by day: the router's books, a UTC day a row; today's row is what its log of answers says it paid today.
{
  const spendCli = (args: string[]) => new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'spend', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
  const dayCsv = (await spendCli(['--by', 'day', '--csv'])).split('\n'), dayText = await spendCli(['--by', 'day']);
  const todayUtc = new Date().toISOString().slice(0, 10), todayStart = Date.parse(`${todayUtc}T00:00:00Z`);
  const paidToday = readTrips(join(WORK, 'home/router/trips.jsonl')).filter((t) => t.at >= todayStart);
  const want = `${todayUtc},${paidToday.length},${paidToday.reduce((a, t) => a + t.inputTokens, 0)},${paidToday.reduce((a, t) => a + t.outputTokens, 0)},${usd(paidToday.reduce((a, t) => a + BigInt(Math.round(Number(t.cost) * 1e6)), 0n))}`;
  check('orrery spend --by day gives your books of what the router paid, a UTC day a row, and --csv the rows for an expense report',
    paidToday.length > 0 && dayCsv[0] === 'day_utc,answers,input_tokens,output_tokens,paid_usdc' && dayCsv[1] === want && dayText.startsWith('last 7d, by day') && dayText.split('\n').some((l) => l.startsWith(todayUtc)),
    dayCsv[1] ?? 'no row');
  // The router's console shows the same books, from /orrery/spend?by=day, and downloads them as CSV from the router itself.
  const sd = await fetch(`${ROUTER}/orrery/spend?since=7d&by=day`).then((r) => r.json()).catch(() => null) as { rows?: { key: string; answers: number; usd: string }[] } | null;
  const sdCsv = await fetch(`${ROUTER}/orrery/spend?by=day&since=90d&format=csv`).then(async (r) => ({ type: r.headers.get('content-type') ?? '', body: await r.text() })).catch(() => ({ type: '', body: '' }));
  const rPage = await (await fetch(`${ROUTER}/`)).text();
  const sdToday = sd?.rows?.find((r) => r.key === todayUtc);
  check('the router’s console shows what you paid by day and downloads it as CSV from the router itself',
    !!sdToday && `${todayUtc},${sdToday.answers},${want.split(',').slice(2, 4).join(',')},${sdToday.usd}` === want && sdCsv.type.startsWith('text/csv') && sdCsv.body.split('\n')[1] === want
    && rPage.includes('id="spendday"') && rPage.includes('href="/orrery/spend?by=day&amp;since=90d&amp;format=csv"'),
    sdToday ? `${sdToday.key}: ${sdToday.answers} answers, $${sdToday.usd} · csv ${sdCsv.type.split(';')[0] || 'none'}` : 'no row for today');
  // And under them, this UTC month so far: every answer in the router's log since the 1st, in the console and the CLI.
  const monthKey = todayUtc.slice(0, 7), inMonth = readTrips(join(WORK, 'home/router/trips.jsonl')).filter((t) => new Date(t.at).toISOString().startsWith(monthKey));
  const monthPaid = usd(inMonth.reduce((a, t) => a + BigInt(Math.round(Number(t.cost) * 1e6)), 0n));
  const sdMonth = (sd as { month?: { month: string; answers: number; usd: string; line: string } } | null)?.month;
  check('the router says what you paid this UTC month so far, under the books by day, in the console and in orrery spend --by day',
    !!sdMonth && sdMonth.month === monthKey && sdMonth.answers === inMonth.length && sdMonth.usd === monthPaid && sdMonth.line.endsWith(`so far (UTC): ${inMonth.length.toLocaleString('en-US')} answers, $${monthPaid} paid`)
    && dayText.split('\n').includes(sdMonth.line) && rPage.includes('id="spendmonth"'),
    sdMonth?.line ?? 'no month in /orrery/spend');
}
// The console page the router serves: the browser that opens it is sent nowhere else, not even for a font.
const consoleHtml = await (await fetch(`${ROUTER}/`)).text();
const consoleOutside = [...consoleHtml.matchAll(/(?:https?:)?\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]).filter((h) => h !== '127.0.0.1');
check('the router’s console page asks nothing of any other computer and carries its typefaces itself', consoleOutside.length === 0 && (consoleHtml.match(/@font-face/g) ?? []).length === 2 && !/<link\b/i.test(consoleHtml), consoleOutside.length ? `the page points a browser at ${[...new Set(consoleOutside)].join(', ')}` : `${Math.round(consoleHtml.length / 1024)} kB page, 2 typefaces inside it, no host but this computer`);
// A second router, started with no wallet: it cannot open a channel, and that is its own problem, not a node's.
const bareHome = join(WORK, 'home-no-wallet');
const bare = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'router', '--port', '17290', '--rpc', RPC, '--mint', usdc.toBase58()], { stdio: 'ignore', env: { ...process.env, ORRERY_HOME: bareHome } });
for (let i = 0; i < 100; i++) { if (await fetch('http://127.0.0.1:17290/orrery/status').then((r) => r.ok).catch(() => false)) break; await sleep(200); }
const bareAsk = await fetch('http://127.0.0.1:17290/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
const bareSaid = (await bareAsk.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
const bareStatus = (await (await fetch('http://127.0.0.1:17290/orrery/status')).json()) as { providers: { name: string | null; observed: { ok: number; fail: number }; watched: { sent?: number } | null }[] };
bare.kill();
const blamed = bareStatus.providers.filter((p) => p.observed.fail > 0 || (p.watched?.sent ?? 0) > 0).map((p) => p.name);
check('a router with no wallet says so and what to do, and counts the request against no node', bareAsk.status === 402 && bareSaid.error?.code === 'wallet' && /orrery router --wallet <keypair\.json>/.test(bareSaid.error?.message ?? '') && /orrery wallet new and start the router again/.test(bareSaid.error?.message ?? '') && blamed.length === 0, `${bareAsk.status} ${bareSaid.error?.code}: ${(bareSaid.error?.message ?? '').slice(0, 110)} · counted against: ${blamed.join(', ') || 'no node'}`);
// Someone with no wallet makes one from the command line, and it is a file the rest of the tools read.
const freshWallet = join(WORK, 'fresh', 'wallet.json');
const walletRun = (args: string[]) => new Promise<{ code: number | null; text: string }>((done) => { let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'wallet', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); pc.stdout!.on('data', (c) => (text += c)); pc.stderr!.on('data', (c) => (text += c)); pc.on('exit', (code) => done({ code, text })); });
const madeWallet = await walletRun(['new', '--out', freshWallet]);
const madeAddress = existsSync(freshWallet) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(freshWallet, 'utf8')))).publicKey.toBase58() : null;
const madeAgain = await walletRun(['new', '--out', freshWallet]);
const saidAddress = await walletRun(['address', '--wallet', freshWallet]);
check('orrery wallet new makes a wallet file, says its address and what to send it, and never replaces one', madeWallet.code === 0 && !!madeAddress && madeWallet.text.includes(`address  ${madeAddress}`) && /about 0\.01 SOL/.test(madeWallet.text) && madeAgain.code === 1 && /there is already a wallet at/.test(madeAgain.text) && saidAddress.text.trim().split('\n').pop() === madeAddress, madeAddress ? `made ${madeAddress.slice(0, 6)}… · a second run: exit ${madeAgain.code}, ${madeAgain.text.trim().split('\n').pop()?.replace(madeAddress, '<address>').replace(freshWallet, '<file>').slice(0, 80)}` : `no wallet file was written (exit ${madeWallet.code})`);
// The wallet made in a home folder is the one a router there uses when no --wallet is given.
const madeHome = join(WORK, 'home-made-wallet');
mkdirSync(madeHome, { recursive: true });
writeFileSync(join(madeHome, 'wallet.json'), readFileSync(freshWallet));
let madeOut = '';
const madeRouter = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'router', '--port', '17290', '--rpc', RPC, '--mint', usdc.toBase58()], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ORRERY_HOME: madeHome } });
madeRouter.stdout!.on('data', (c) => (madeOut += c));
for (let i = 0; i < 100; i++) { if (await fetch('http://127.0.0.1:17290/orrery/status').then((r) => r.ok).catch(() => false)) break; await sleep(200); }
const madeAsk = await fetch('http://127.0.0.1:17290/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
const madeSaid = (await madeAsk.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
madeRouter.kill();
check('a router started with no --wallet uses the wallet made in its home folder, and says so', madeOut.includes(`wallet ${madeAddress?.slice(0, 6)}…`) && /using the wallet in .*wallet\.json/.test(madeOut) && madeAsk.status === 402 && (madeSaid.error?.message ?? '').startsWith(`your wallet ${madeAddress} has $0.00 USDC`), `${(madeOut.split('\n').find((l) => /router on/.test(l)) ?? 'no start line').replace(/.*route auto {2}· {2}/, '').slice(0, 40)} · asked: ${madeAsk.status} ${(madeSaid.error?.message ?? '').replace(madeAddress ?? '-', '<address>').slice(0, 70)}`);
// `orrery connect` looks at the router it points at before it hands out settings.
const connectOut = (args: string[], homeDir: string) => new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'connect', ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: Object.fromEntries(Object.entries({ ...process.env, ORRERY_HOME: homeDir }).filter(([k]) => k !== 'ORRERY_WALLET')) }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const emptyHome = join(WORK, 'home-nothing');
mkdirSync(emptyHome, { recursive: true });
const [conDown, conDownNoWallet, conUp, conUnlisted] = await Promise.all([
  connectOut(['openai', '--router', 'http://127.0.0.1:17997'], madeHome),
  connectOut(['openai', '--router', 'http://127.0.0.1:17997'], emptyHome),
  connectOut(['openai', '--router', ROUTER], madeHome),
  connectOut(['openai', '--router', ROUTER, '--model', 'nope-1'], madeHome),
]);
check('orrery connect says when no router answers where its settings point, how to start one, and when the model asked for is not listed', /note: no router answers at http:\/\/127\.0\.0\.1:17997 yet.*Start one first: \S+ router$/.test(conDown) && /Start one first: \S+ wallet new .*then \S+ router$/.test(conDownNoWallet) && conUp.includes('model: gpt-oss-120b') && !conUp.includes('note:') && /note: your router does not list nope-1 right now.*It lists: /.test(conUnlisted), `nothing there: ${(conDown.split('\n').find((l) => l.startsWith('note:')) ?? 'no note').slice(0, 60)}… · running: ${conUp.includes('note:') ? 'a note' : 'no note'} · nope-1: ${(conUnlisted.split('\n').find((l) => l.startsWith('note:')) ?? 'no note').slice(0, 44)}…`);
// A new operator with no Solana tools: the draft names the wallet `orrery wallet new` made, or where it will make one.
const initAs = (homeDir: string, out: string) => new Promise<string>((done) => { let text = ''; const pi = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'init', '--offline', '--upstream', 'http://127.0.0.1:19102/v1', '--out', out], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.fromEntries(Object.entries({ ...process.env, ORRERY_HOME: homeDir, HOME: homeDir }).filter(([k]) => k !== 'ORRERY_WALLET')) }); pi.stdout!.on('data', (c) => (text += c)); pi.stderr!.on('data', (c) => (text += c)); pi.on('exit', () => done(text)); });
const [initMade, initNone] = await Promise.all([initAs(madeHome, join(WORK, 'init-made.json')), initAs(emptyHome, join(WORK, 'init-none.json'))]);
const walletOf = (f: string) => (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { wallet?: string }).wallet : undefined);
check('orrery provider init names the wallet orrery wallet new made and the address the node will be listed under; with none yet, it says how to make it, and the register step asks for no second file', walletOf(join(WORK, 'init-made.json')) === join(madeHome, 'wallet.json') && initMade.includes(`the node will be listed under ${madeAddress}`) && !initMade.includes('there is no') && walletOf(join(WORK, 'init-none.json')) === join(emptyHome, 'wallet.json') && /note: there is no wallet at \S+wallet\.json yet\. \S+ wallet new makes one there\./.test(initNone) && !initMade.includes('<keypair.json>'), `with a wallet: ${initMade.includes('listed under') ? 'listed under <address>' : 'no address line'} · without: ${(initNone.split('\n').find((l) => l.startsWith('note:')) ?? 'no note').replace(emptyHome, '<home>').slice(0, 78)}…`);
// The router's own record of speed: every answer's first-token time is in its log, and each node gets its median.
const spendSaid = (await (await fetch(`${ROUTER}/orrery/spend?since=24h`)).json()) as { speed?: { provider: string; name: string; answers: number; medianTtftMs: number }[] };
const loggedWithTime = readTrips(join(process.env.ORRERY_HOME ?? '', 'router', 'trips.jsonl')).filter((x) => typeof (x as { ttftMs?: number }).ttftMs === 'number').length;
check('the router keeps how fast each node started answering, by its own clock, and gives each node its median', (spendSaid.speed ?? []).length >= 3 && (spendSaid.speed ?? []).every((x) => x.answers >= 1 && x.medianTtftMs >= 0 && x.name.length > 0) && loggedWithTime >= 20 && doc.some((l) => l.what.trim() === 'speed' && /started answering in \d/.test(l.detail)), `${(spendSaid.speed ?? []).slice(0, 3).map((x) => `${x.name} ${x.medianTtftMs} ms over ${x.answers}`).join(' · ') || 'no speed in /orrery/spend'} · doctor: ${doc.find((l) => l.what.trim() === 'speed')?.detail.slice(0, 80) ?? 'no speed line'}`);
// What the router counted of each node (answers, failures, speed) is on disk, so a router started again from the same
// home goes on from it: a fresh count read from the file matches the running one, and no cooldown comes with it.
{
  (router.stats as unknown as { flush?: () => void }).flush?.();
  const { Stats } = await import('../src/router/policy.ts');
  const again = new (Stats as unknown as new (path?: string) => InstanceType<typeof Stats>)(OBSERVED);
  const live = [...router.stats.all().entries()];
  const same = live.filter(([a, o]) => { const b = again.get(a); return b.ok === o.ok && b.fail === o.fail && b.ttftMs === o.ttftMs && (b.broke ?? 0) === (o.broke ?? 0) && b.cooldownUntil === 0; });
  const failed = live.filter(([, o]) => o.fail > 0).length;
  check('the router keeps its own count of each node’s answers, failures and speed in its home, so a restart does not forget a node that failed it', live.length >= 3 && failed >= 1 && same.length === live.length,
    `${same.length} of ${live.length} nodes read back the same from ${existsSync(OBSERVED) ? 'router/observed.json' : 'no file'} · ${failed} with failures on record`);
}
// The same record in the status a console or an agent reads: lines a person can read, and the speed as numbers.
const recordSaid = (await (await fetch(`${ROUTER}/orrery/status`)).json()) as { providers: { name: string | null; record?: string[]; speed?: { answers: number; medianTtftMs: number } | null }[] };
const ironRecord = recordSaid.providers.find((p) => p.name === 'Ironbridge Compute');
const recordConsole = await (await fetch(`${ROUTER}/`)).text();
check('the router’s status and its console carry its own record of each node: checks, answers and speed, beside what the chain says', !!ironRecord?.speed && ironRecord.speed.answers >= 1 && (ironRecord.record ?? []).some((l) => /^started answering in \d/.test(l)) && (ironRecord.record ?? []).some((l) => /^answered /.test(l)) && recordConsole.includes('this router’s record'), `Ironbridge Compute: ${(ironRecord?.record ?? ['no record in /orrery/status']).join(' · ').slice(0, 170)}`);
// What each node billed, beside what the prices it listed on chain come to: kept for every answer, counted per node.
const billedLogged = readTrips(join(process.env.ORRERY_HOME ?? '', 'router', 'trips.jsonl')).filter((x) => typeof (x as { billed?: string }).billed === 'string' && typeof (x as { listed?: string }).listed === 'string');
const billsSaid = (spendSaid as { bills?: { name: string; checked: number; over: number }[] }).bills ?? [];
check('the router keeps what each node billed beside what its listed prices come to, and its record says how many bills were within those prices',
  billedLogged.length >= 20 && billsSaid.length >= 3 && billsSaid.every((b) => b.checked >= 1 && b.over === 0) && (ironRecord?.record ?? []).some((l) => /^(every bill was|its bill was) within its listed prices \(/.test(l)) && doc.some((l) => l.what.trim() === 'bills' && /within its listed prices/.test(l.detail)),
  `${billedLogged.length} answers logged with both · ${billsSaid.map((b) => `${b.name} ${b.checked - b.over}/${b.checked} within`).join(', ') || 'no bills record'}`);
check('router logged every answered request', trips.length === 44 + codexTrips + claudeTrips + loadTrips, `${trips.length} trips`);

const ib = nodes[1];
// The key a node's own pages ask for (console.key in its folder); a node from before it had one ignores it.
const ibKey = (nodes[1] as unknown as { consoleKey?: () => string }).consoleKey?.() ?? '';
const ibStatus = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/status`, { headers: { 'x-orrery-console-key': ibKey } })).json()) as { answers: number; signed: string; waiting: string; channels: { signed: string }[] };
const ibSigned = channels.get(ib.pda.toBase58())?.cumulative ?? 0n;
const relayed = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/status`, { headers: { 'x-forwarded-for': '203.0.113.7', 'x-orrery-console-key': ibKey } });
// A front on the node's own machine that relays without saying so (nginx's defaults: Host rewritten to 127.0.0.1, no
// X-Forwarded-For) looks exactly like this computer. The node's own pages also need the key only its disk holds, so
// such a front, or anyone it relays, reads no channel from them.
const frontLike = { host: `127.0.0.1:${providerSpecs[1].port}` };
const rawRead = (port: number, path: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((done) => {
  const r = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => (body += c)); res.on('end', () => done({ status: res.statusCode ?? 0, body })); });
  r.on('error', () => done({ status: 0, body: '' }));
  r.end();
});
const asFront = await Promise.all(['/orrery/status', '/orrery/earnings?since=24h', '/'].map((p) => rawRead(providerSpecs[1].port, p, frontLike)));
const withKey = await Promise.all(['/orrery/status', '/orrery/earnings?since=24h'].map((p) => rawRead(providerSpecs[1].port, p, { ...frontLike, 'x-orrery-console-key': ibKey })));
const consolePage = await rawRead(providerSpecs[1].port, `/?key=${ibKey}`, frontLike);
check('a front on the node’s machine that relays like this computer reads nothing from the node’s own pages without the key on its disk', asFront.every((r) => r.status !== 200 && !/channel/.test(r.body)) && withKey.every((r) => r.status === 200) && consolePage.status === 200 && /Your node/.test(consolePage.body), `without the key: ${asFront.map((r) => r.status).join(', ')} · with it: ${withKey.map((r) => r.status).join(', ')} · console page with ?key: ${consolePage.status}`);
// An operator whose start output is gone gets the address back from the command line, from the node's own folder.
const ironCfgPath = join(WORK, 'ironbridge-provider.json');
writeFileSync(ironCfgPath, JSON.stringify(nodes[1].cfg));
const consoleOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'console', '--config', ironCfgPath], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const consoleUrl = consoleOut.split('\n')[0] ?? '';
const consoleOpened = /^http:\/\/127\.0\.0\.1:\d+\/\?key=[0-9a-f]{32}$/.test(consoleUrl) ? await rawRead(providerSpecs[1].port, new URL(consoleUrl).pathname + new URL(consoleUrl).search, frontLike) : null;
// The same numbers in a terminal, for a node on a server with no browser; and a plain answer when no node is running.
const cliOut = (args: string[]) => new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', ...args, '--config', ironCfgPath], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const statusOut = await cliOut(['status']);
const ibStatusNow = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/status`, { headers: { 'x-orrery-console-key': ibKey } })).json()) as { answers: number; signed: string; redeemed: string; waiting: string; channels: unknown[] };
const statusDown = await cliOut(['status', '--port', '17998']);
// A compose file written for a package other than the default (a pinned version, a packed file): the file runs that
// package, and so does the command it tells the operator to run inside the container.
const composeAt = join(WORK, 'compose-check.yml');
const composeSaid = await cliOut(['compose', '--out', composeAt, '--package', 'orrery-node@9.9.9', '--force']);
const composeWrote = existsSync(composeAt) ? readFileSync(composeAt, 'utf8') : '';
check('orrery provider compose writes the file for the package it was given, and the command it prints names that package too', /command: "npx -y --package=orrery-node@9\.9\.9 orrery provider start /.test(composeWrote) && /docker compose exec node npx -y --package=orrery-node@9\.9\.9 orrery provider status /.test(composeSaid), (composeSaid.split('\n').find((l) => /docker compose exec/.test(l)) ?? 'no such line').replace(/--config .*/, '--config …').slice(0, 150));
// What is waiting, and when it lands: the rehearsal's nodes redeem anything, once an hour.
const waitingLine = statusOut.split('\n').find((l) => /^\s+waiting to redeem\s/.test(l)) ?? '';
check('orrery provider status says when what is waiting gets paid out', Number(ibStatusNow.waiting) > 0 && /pays out at the next round, every 60 min\)$/.test(waitingLine), waitingLine.trim().replace(/\s{2,}/g, ' ') || 'no such line');
check('orrery provider status tells a node never paid out on chain that its first payout goes out at the next round', /\(your first payout: pays out at the next round, every 60 min\)$/.test(waitingLine), waitingLine.trim().replace(/\s{2,}/g, ' ') || 'no such line');
// The running node counts the next payout channel by channel, as its payout round does, and its console says it in a
// sentence under the payouts: everything waiting here is due, since this node has not been paid out yet.
const ibNext = (ibStatusNow as unknown as { nextPayout?: { due: string; below: string; first: boolean; everySecs: number } }).nextPayout;
const ibNextSaid = ((await import('../src/provider/payouts.ts')) as unknown as { nextPayoutSentence?: (n: unknown) => string }).nextPayoutSentence?.(ibNext) ?? '';
const ibConsole = await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/?key=${ibKey}`)).text();
check('the node counts its next payout channel by channel and its console says when the money goes out', !!ibNext && ibNext.first && ibNext.below === '0' && usd(BigInt(ibNext.due)) === ibStatusNow.waiting
  && ibNextSaid === `$${ibStatusNow.waiting} goes out in the next round, within 60 min, as this node’s first payout.` && ibConsole.includes('id="next"') && ibConsole.includes('nextPayoutSentence(s.nextPayout)'), ibNextSaid || 'no next payout in the status');
// The fee money too, before it is a problem: SOL on the node key and about how many payouts it pays for; and the same
// as JSON for a monitor.
const statusJson = await cliOut(['status', '--json']);
const ironLamports = await conn.getBalance(nodes[1].node.publicKey);
const parsedStatus = (() => { try { return JSON.parse(statusJson) as { answers?: number; feeLamports?: number; payoutsLeft?: number; waiting?: string }; } catch { return null; } })();
const statusFeeLine = statusOut.split('\n').find((l) => /^\s+fees\s/.test(l)) ?? '';
// When it last answered, for a monitor that wants to know a node is still getting work.
const ibRecent = ((await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/status`, { headers: { 'x-orrery-console-key': ibKey } })).json()) as { recent: { at: number }[] }).recent;
const lastLine = statusOut.split('\n').find((l) => /^\s+last answer\s/.test(l)) ?? '';
const lastJson = (() => { try { return (JSON.parse(statusJson) as { lastAnswerAt?: string | null }).lastAnswerAt ?? null; } catch { return null; } })();
check('orrery provider status says when the node last answered, and gives the time as JSON for a monitor', ibRecent.length > 0 && /last answer\s+(\d+ s|\d+ min|\d+ h) ago \(\d{2}:\d{2}:\d{2} UTC\)$/.test(lastLine) && lastJson === new Date(ibRecent[0].at).toISOString(), `${lastLine.trim().replace(/\s{2,}/g, ' ') || 'no such line'} · json: ${lastJson ?? 'none'}`);
// A wallet whose USDC account the first payout still has to open: that payout is counted before the rest.
const ironOpening = (await conn.getAccountInfo(pda.ata(nodes[1].authority, usdc))) === null ? await conn.getMinimumBalanceForRentExemption(165) : 0;
const ironFeePayouts = Math.floor(Math.max(0, ironLamports - ironOpening) / 5_000);
check('orrery provider status says how much SOL the node key has for fees and about how many payouts that pays for, and prints JSON for a monitor', new RegExp(`${(ironLamports / 1e9).toFixed(4)} SOL on the node key, about ${ironFeePayouts.toLocaleString('en-US')} payouts`).test(statusFeeLine) && parsedStatus?.answers === ibStatusNow.answers && parsedStatus?.feeLamports === ironLamports && parsedStatus?.payoutsLeft === ironFeePayouts && parsedStatus?.waiting === ibStatusNow.waiting, `${statusFeeLine.trim().replace(/\s{2,}/g, ' ') || 'no fee line'} · json: ${parsedStatus ? `${parsedStatus.answers} answers, ${parsedStatus.payoutsLeft} payouts left` : 'not JSON'}`);
// The last day from the node's own log of answers, which a restart does not reset: the count and what they billed.
const ibDay = summarize(readTrips(join(WORK, 'providers', 'ironbridge', 'served.jsonl')), 'model', 86_400_000).total;
const dayStatusLine = statusOut.split('\n').find((l) => /^\s+last 24 h\s/.test(l)) ?? '';
const dayJson = (() => { try { return (JSON.parse(statusJson) as { day?: { answers: number; billed: string } | null }).day ?? null; } catch { return null; } })();
check('orrery provider status says what the last 24 hours billed, counted from the node’s own log of answers, in words and as JSON', ibDay.answers > 0 && dayStatusLine.trim().replace(/\s{2,}/g, ' ') === `last 24 h ${ibDay.answers.toLocaleString('en-US')} answers, $${usd(ibDay.units)} billed` && dayJson?.answers === ibDay.answers && dayJson?.billed === usd(ibDay.units),
  dayStatusLine.trim().replace(/\s{2,}/g, ' ') || 'no such line');
// Where the listing stands, in the command an operator runs most: as listed, and after editing a price in
// provider.json without listing it again, the mistake that leaves a node with no routers and no error.
const listingNow = statusOut.split('\n').find((l) => /^\s+listing\s/.test(l)) ?? '';
const editedCfgPath = join(WORK, 'ironbridge-edited.json');
writeFileSync(editedCfgPath, JSON.stringify({ ...nodes[1].cfg, models: nodes[1].cfg.models.map((m, i) => (i === 0 ? { ...m, price: { ...m.price, input: m.price.input + 1_000 } } : m)) }));
const editedOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'status', '--config', editedCfgPath], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const listingEdited = editedOut.split('\n').find((l) => /^\s+listing\s/.test(l)) ?? '';
// Whether anything outside is reaching the node: a check from this computer does not count, nor does the operator's
// own provider check going out and back through the public address; a request relayed from outside does.
const ibPort = providerSpecs[1].port;
const reachNow = async () => ((await (await fetch(`http://127.0.0.1:${ibPort}/orrery/status`, { headers: { 'x-orrery-console-key': ibKey } })).json()) as { reach?: { lastHour: number; lastAt: number | null } }).reach;
const reachBefore = await reachNow();
// A fresh node in the same rehearsal says in its own log when something outside first reaches it, and only once.
const firstLines: string[] = [];
const freshReach = Object.assign(Object.create(nodes[1]) as object, { reach: new (await import('../src/provider/reach.ts')).Reach(), log: (l: string) => void firstLines.push(l) }) as unknown as { handle: (req: never, res: never) => Promise<void> };
const asOutside = { headers: { host: 'gpu.example.org' }, socket: { remoteAddress: '127.0.0.1' }, method: 'GET', url: '/health' };
const sink = () => ({ writeHead: () => sink(), end: () => undefined, setHeader: () => undefined }) as never;
await freshReach.handle(asOutside as never, sink());
await freshReach.handle(asOutside as never, sink());
await freshReach.handle({ ...asOutside, headers: { host: `127.0.0.1:${providerSpecs[1].port}` } } as never, sink());
check('a node says in its own log when something outside first reaches it, once', firstLines.filter((l) => /^reached from outside \d+ s after starting: the public address works/.test(l)).length === 1, firstLines.find((l) => l.startsWith('reached')) ?? 'no such line');
await rawRead(ibPort, '/health', { host: `127.0.0.1:${ibPort}` });
await rawRead(ibPort, '/health', { host: 'gpu.example.org', 'x-orrery-own-check': '1' });
const reachOwn = await reachNow();
await rawRead(ibPort, '/health', { host: 'gpu.example.org', 'x-forwarded-for': '203.0.113.9' });
await rawRead(ibPort, '/health', { host: 'gpu.example.org' });
const reachOutside = await reachNow();
const reachSaid = (await cliOut(['status'])).split('\n').find((l) => /^\s+checked from outside\s/.test(l)) ?? '';
check('orrery provider status says how often something outside this computer checked the node, and its own checks do not count', !!reachBefore && reachOwn?.lastHour === reachBefore.lastHour && reachOutside?.lastHour === reachBefore.lastHour + 2 && /checked from outside\s+\d+ times? in the last hour, the last \d+ s ago$/.test(reachSaid), reachSaid.trim().replace(/\s{2,}/g, ' ') || `no such line (${JSON.stringify(reachOutside ?? null)})`);
// The node's own console says it too, from the same numbers, in the page the operator keeps open.
const reachPage = await (await fetch(`http://127.0.0.1:${ibPort}/?key=${ibKey}`)).text();
const reachMod = (await import('../src/provider/reach.ts')) as unknown as { reachSentence?: (r: unknown, now: number) => string };
const reachSentenceSaid = reachMod.reachSentence?.(reachOutside, Date.now()) ?? '';
check('the node’s console says whether anything outside this computer is reaching the node', reachPage.includes('id="reach"') && reachPage.includes('const reachSentence=') && /^Checked from outside this computer \d+ times? in the last hour, the last \d+ s ago: routers can reach this node\.$/.test(reachSentenceSaid), reachSentenceSaid || 'no sentence');
// Listed but not restarted: a node still serving a price list the chain has moved on from. Routers refuse it, and
// provider.json agrees with the chain, so only what the running node serves can show it.
let staleOwnCheck = '';
const staleNode = createHttpServer((req, res) => {
  if (req.url?.startsWith('/orrery/status')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...ibStatusNow, manifestHash: 'ff'.repeat(32) }));
  if (req.url === '/health') { staleOwnCheck = String(req.headers['x-orrery-own-check'] ?? ''); return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ provider: nodes[1].pda.toBase58() })); }
  if (req.url === '/v1/manifest') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"stale":true}');
  res.writeHead(404).end();
}).listen(0, '127.0.0.1');
await new Promise((r) => staleNode.once('listening', r));
const stalePort = (staleNode.address() as { port: number }).port;
const staleCfgPath = join(WORK, 'ironbridge-stale.json');
writeFileSync(staleCfgPath, JSON.stringify({ ...nodes[1].cfg, listen: stalePort }));
const staleOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'status', '--config', staleCfgPath], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const listingStale = staleOut.split('\n').find((l) => /^\s+listing\s/.test(l)) ?? '';
check('orrery provider status judges the listing by what the running node serves: edited and not listed yet, routers still get the listed prices; listed and not restarted, routers refuse it', /on chain, with this node’s prices and address$/.test(listingNow) && listingEdited.includes('new prices that are not live yet, and routers still get the listed ones') && listingEdited.endsWith('then restart the node') && listingStale.includes('still serves its old prices, so a router reading them now refuses it') && listingStale.endsWith(`orrery provider start --config ${staleCfgPath}`) && (parsedStatus as { listing?: string } | null)?.listing === 'listed',
  `edited: ${listingEdited.trim().replace(/\s{2,}/g, ' ').replace(editedCfgPath, '<config>').slice(0, 90)} · not restarted: ${listingStale.trim().replace(/\s{2,}/g, ' ').replace(staleCfgPath, '<config>').slice(0, 90)}`);
check('orrery provider status prints what the console shows, from the running node, and says plainly when no node is running', statusOut.includes(nodes[1].pda.toBase58()) && new RegExp(`answers since start\\s+${ibStatusNow.answers}\\b`).test(statusOut) && statusOut.includes(`$${ibStatusNow.signed}`) && statusOut.includes(`$${ibStatusNow.waiting}`) && new RegExp(`channels\\s+${ibStatusNow.channels.length}\\b`).test(statusOut) && /no node is answering on 127\.0\.0\.1:17998/.test(statusDown) && /provider start --config/.test(statusDown), `${statusOut ? statusOut.split('\n').slice(1).map((l) => l.trim().replace(/\s{2,}/g, ' ')).join(' · ') : 'printed nothing'} · with no node: ${statusDown.split('.')[0] || 'printed nothing'}`);
check('orrery provider console prints the console’s address with its key, and that address opens the console', !!ibKey && consoleUrl === `http://127.0.0.1:${providerSpecs[1].port}/?key=${ibKey}` && consoleOpened?.status === 200 && /Your node/.test(consoleOpened.body) && (asFront[2]?.body ?? '').includes('provider console'), `${consoleUrl ? consoleUrl.replace(/key=[0-9a-f]+/, 'key=<32 hex>') : 'printed nothing'} → ${consoleOpened?.status ?? 'not opened'} · the keyless page ${(asFront[2]?.body ?? '').includes('provider console') ? 'names the command' : 'does not name the command'}`);
check('the provider console shows what routers signed to it, and only on its own computer', ibStatus.signed === usd(ibSigned) && ibStatus.waiting === usd(ibSigned) && ibStatus.answers > 0 && relayed.status === 404, `Ironbridge: ${ibStatus.answers} answers · $${ibStatus.signed} signed · $${ibStatus.waiting} waiting · relayed request ${relayed.status}`);
const ibBefore = channels.get(ib.pda.toBase58())!;
const reborn = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels-after-restart.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
const picked = await reborn.ensure(ib.pda.toBase58(), 1n);
const stranger = new Channels(conn, user, Keypair.generate(), usdc, join(WORK, 'home/router/channels-stranger.json'), { deposit: USD, topUpBelow: 0n, dailyCap: USD });
const strangerFound = await (stranger as unknown as { recover(p: string): Promise<unknown> }).recover(ib.pda.toBase58());
check('a router that lost its channel records picks its channel back up from the node’s last voucher, and only with its own session key',
  picked.channel === ibBefore.channel && picked.cumulative === ibBefore.cumulative && picked.usageHash.equals(ibBefore.usageHash) && strangerFound === null,
  `Ironbridge channel ${picked.channel.slice(0, 6)}… resumed at $${usd(picked.cumulative)} signed · another session key: ${strangerFound === null ? 'not resumed' : 'resumed'}`);
// A router whose session.json was replaced still remembers the channel, but every voucher it signs now is refused
// by the node. It lets the channel go and says how to get the deposit back; with no wallet, it opens nothing.
writeFileSync(join(WORK, 'home/router/channels-rekeyed.json'), readFileSync(join(WORK, 'home/router/channels.json')));
const rekeyed = new Channels(conn, null, Keypair.generate(), usdc, join(WORK, 'home/router/channels-rekeyed.json'), { deposit: USD, topUpBelow: 0n, dailyCap: USD });
const rekeyedSaid: string[] = [];
(rekeyed as unknown as { note?: (line: string) => void }).note = (l) => rekeyedSaid.push(l);
const rekeyedGot = await rekeyed.ensure(ib.pda.toBase58(), 1n).then((c) => `paid through ${c.channel === ibBefore.channel ? 'the old channel' : c.channel.slice(0, 6)}`, (e: Error) => `refused: ${e.message.slice(0, 60)}`);
check('a router whose session key changed stops paying through the channel it opened under the old key, and says how to get that deposit back',
  rekeyedGot.startsWith('refused') && rekeyed.get(ib.pda.toBase58()) === undefined && rekeyedSaid.some((l) => l.includes(ibBefore.channel) && /another session key/.test(l) && new RegExp(`close ${ibBefore.channel} --wallet`).test(l)),
  `${rekeyedGot} · ${(rekeyedSaid[0] ?? 'nothing said').slice(0, 90)}`);
// A router set to a deposit below the program's minimum (USD / 10 here) says that, not the program's error code.
const small = new Channels(conn, user, Keypair.generate(), usdc, join(WORK, 'home/router/channels-small.json'), { deposit: USD / 20n, topUpBelow: 0n, dailyCap: USD });
const smallSaid = await small.ensure(ib.pda.toBase58(), 1n).then((c) => `opened ${c.channel.slice(0, 6)}…`, (e: Error) => e.message);
check('a router set to a deposit below the program’s minimum says what the minimum is and which --deposit to use, and opens nothing',
  /at least \$0\.10 on this network and this router is set to \$0\.05/.test(smallSaid) && /--deposit 0\.1 or more/.test(smallSaid) && !/Simulation failed|DepositTooSmall/.test(smallSaid) && small.get(ib.pda.toBase58()) === undefined,
  smallSaid.split('\n')[0].slice(0, 140));
// The node that went dark earlier still has this router's channel open on chain. A router that lost its records
// finds that channel, cannot ask the node where it stands, and must not open (and fund) a second one on a guess.
const dark = nodes[0].pda;
const channelsTo = async (provider: PublicKey) => (await conn.getProgramAccounts(new PublicKey(PROGRAM_ID), { filters: [
  { memcmp: { offset: 0, bytes: Buffer.from(ACCOUNT.Channel).toString('base64'), encoding: 'base64' } }, { memcmp: { offset: 8, bytes: user.publicKey.toBase58() } }, { memcmp: { offset: 40, bytes: provider.toBase58() } },
] })).length;
const darkBefore = await channelsTo(dark);
const blind = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels-blind.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
const blindSaid = await blind.ensure(dark.toBase58(), 1n).then((c) => `opened or resumed ${c.channel.slice(0, 6)}…`, (e: Error) => `refused: ${e.message}`);
const darkAfter = await channelsTo(dark);
check('a router that lost its records and cannot reach the node does not open a second channel to it', darkBefore === 1 && darkAfter === 1 && blindSaid.startsWith('refused') && /did not say where it stands/.test(blindSaid), `channels on chain to the dark node: ${darkBefore} before, ${darkAfter} after · ${blindSaid.slice(0, 150)}`);
mockOf.halo.kill();
await sleep(16_000);
const haloHealth = (await (await fetch(`http://127.0.0.1:${providerSpecs[3].port}/health`)).json()) as { upstream?: string };
const ibHealth = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/health`)).json()) as { upstream?: string };
check('a node says on /health when its model server is down, before any router pays for a request it cannot serve', haloHealth.upstream === 'down' && ibHealth.upstream === 'up', `Halo with its model server stopped: ${haloHealth.upstream} · Ironbridge: ${ibHealth.upstream}`);
await registry.checkHealth();
const signedBefore = channels.list().reduce((a, c) => a + c.cumulative, 0n);
const skipped = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemma-3-27b', max_tokens: 32, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const skippedJ = (await skipped.json()) as { error?: { code?: string; message?: string } };
const signedAfter = channels.list().reduce((a, c) => a + c.cumulative, 0n);
check('the router skips a node whose model server is down before sending or paying anything', skipped.status === 503 && /model server down/.test(skippedJ.error?.message ?? '') && signedAfter === signedBefore, `gemma (only Halo lists it) → ${skipped.status}: ${skippedJ.error?.message} · signed total unchanged`);
// Every ten minutes a refresh re-reads a node's price list and builds its entry again. What the router last saw of the
// node's health has to survive that: otherwise a node known to be down is forgotten until the next health check.
const haloBefore = registry.entries.get(nodes[3].pda.toBase58())!;
haloBefore.checkedAt = 0;
await registry.refresh();
const haloRebuilt = registry.entries.get(nodes[3].pda.toBase58())!;
const skippedAgain = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gemma-3-27b', max_tokens: 32, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const skippedAgainJ = (await skippedAgain.json()) as { error?: { message?: string } };
check('a registry refresh that rebuilds a node’s entry keeps what the router last saw of its health, so a node known to be down stays skipped', haloRebuilt !== haloBefore && haloRebuilt.upstream === 'down' && typeof haloRebuilt.healthAt === 'number' && skippedAgain.status === 503 && /model server down/.test(skippedAgainJ.error?.message ?? ''), `rebuilt: ${haloRebuilt !== haloBefore} · model server after the rebuild: ${haloRebuilt.upstream ?? 'unknown'} · the request right after: ${skippedAgain.status} ${(skippedAgainJ.error?.message ?? '').slice(0, 70)}`);
const statusNow = (await (await fetch(`${ROUTER}/orrery/status`)).json()) as { providers: { name: string | null; modelServer: string | null; healthMs: number | null }[] };
const stateOf = (n: string) => statusNow.providers.find((p) => p.name === n);
// The same checks kept as a record: how often this router itself found each node up. Halo's model server was switched
// off mid-run, so some of its checks found it down; Ironbridge was up at every one.
type WatchedRec = { checks: number; up: number; since: number } | null | undefined;
const watchedOf = (n: string) => (stateOf(n) as unknown as { watched?: WatchedRec } | undefined)?.watched ?? null;
const haloW = watchedOf('Halo Compute'), ironW = watchedOf('Ironbridge Compute');
const docAgain = await doctor({ rpc: RPC, mint: usdc, wallet: user.publicKey, router: ROUTER, deposit: USD });
const watchedLine = (n: string) => docAgain.find((l) => l.what.trim() === 'watched' && l.detail.startsWith(n))?.detail ?? null;
// The record is on disk, so a router that restarts goes on counting from where it was.
const restarted = new (Registry as unknown as new (...a: unknown[]) => InstanceType<typeof Registry>)(conn, { allowDev: true, measurements: [] }, undefined, WATCHED);
const keptIron = (restarted as unknown as { watched?: (a: string) => WatchedRec }).watched?.(nodes[1].pda.toBase58()) ?? null;
// The same file keeps what the node did with this router's requests, so that count outlives the router too.
const ironAskedRec = ironW as unknown as { sent?: number; answered?: number; askedSince?: number } | null;
const keptAsked = keptIron as unknown as { sent?: number; answered?: number; askedSince?: number } | null;
check('a router that restarts keeps its count of what each node did with its requests', typeof ironAskedRec?.sent === 'number' && ironAskedRec.sent >= 20 && (ironAskedRec.answered ?? 0) < ironAskedRec.sent && keptAsked?.sent === ironAskedRec.sent && keptAsked?.answered === ironAskedRec.answered && keptAsked?.askedSince === ironAskedRec.askedSince, `before: ${ironAskedRec?.sent === undefined ? 'no count on disk' : `${ironAskedRec.answered}/${ironAskedRec.sent}`} · a new registry on the same folder starts at: ${keptAsked?.sent === undefined ? 'nothing' : `${keptAsked.answered}/${keptAsked.sent}`}`);
check('a router that restarts keeps its record of each node: it is read back from its home folder', !!ironW && !!keptIron && keptIron.checks >= ironW.checks && keptIron.up >= ironW.up && keptIron.since === ironW.since && existsSync(WATCHED), `before: ${ironW ? `${ironW.up}/${ironW.checks}` : 'no record'} · a new registry on the same folder starts at: ${keptIron ? `${keptIron.up}/${keptIron.checks}` : 'nothing'}`);
// Kestrel went dark earlier in the run. Its last answer said 'up'; what is true now is that it does not answer.
const kestrelNow = stateOf('Kestrel GPU Co-op') as unknown as { answering?: boolean | null; unansweredSince?: number | null } | undefined;
const ironNow = stateOf('Ironbridge Compute') as unknown as { answering?: boolean | null } | undefined;
check('a node that stopped answering health checks is shown as not answering, not as up from its last answer', kestrelNow?.answering === false && typeof kestrelNow.unansweredSince === 'number' && ironNow?.answering === true, `Kestrel (dark since early in the run): answering ${String(kestrelNow?.answering)} · Ironbridge: answering ${String(ironNow?.answering)}`);
// And what each node did with the requests this router sent it: Ironbridge answered nearly all (two of its streams
// were dropped mid-answer on purpose earlier in the run), Kestrel went dark and left most.
const askedLine = (name: string) => docAgain.find((l) => l.what.trim() === 'asked' && l.detail.startsWith(name))?.detail ?? '';
const askedOf = (name: string) => { const m = /answered (\d+) of (\d+) requests this router sent it (?:since it started|over \d+ (?:s|min|h|days?))$/.exec(askedLine(name)); return m ? { answered: Number(m[1]), sent: Number(m[2]) } : null; };
const ironAsked = askedOf('Ironbridge Compute'), kestrelAsked = askedOf('Kestrel GPU Co-op');
check('the router keeps count of what each node did with its requests, and doctor shows it beside the health checks', !!ironAsked && ironAsked.answered >= 20 && ironAsked.sent - ironAsked.answered >= 1 && ironAsked.sent - ironAsked.answered <= 3 && !!kestrelAsked && kestrelAsked.answered < kestrelAsked.sent && kestrelAsked.sent - kestrelAsked.answered >= 2, `${askedLine('Ironbridge Compute') || 'doctor says nothing about Ironbridge'} · ${askedLine('Kestrel GPU Co-op') || 'nothing about Kestrel'}`);
check('the router keeps its own record of each node: how many health checks it made and how many found the node up, in status and in doctor', !!ironW && ironW.checks >= 2 && ironW.up === ironW.checks && !!haloW && haloW.checks >= 2 && haloW.up < haloW.checks && haloW.up >= 1 && new RegExp(`^Ironbridge Compute up in ${ironW.up} of ${ironW.checks} checks this router made over `).test(watchedLine('Ironbridge Compute') ?? '') && /^Halo Compute up in \d+ of \d+ checks/.test(watchedLine('Halo Compute') ?? ''), `Ironbridge ${ironW ? `${ironW.up}/${ironW.checks}` : 'no record'} · Halo ${haloW ? `${haloW.up}/${haloW.checks}` : 'no record'} · doctor: ${watchedLine('Halo Compute') ?? 'no line'}`);
check('the router reports each node’s model server in its status and console', stateOf('Halo Compute')?.modelServer === 'down' && stateOf('Ironbridge Compute')?.modelServer === 'up' && typeof stateOf('Ironbridge Compute')?.healthMs === 'number', `/orrery/status · Halo ${stateOf('Halo Compute')?.modelServer} · Ironbridge ${stateOf('Ironbridge Compute')?.modelServer} in ${stateOf('Ironbridge Compute')?.healthMs} ms`);
// orrery providers, run against the same home: under each node, what this router saw of it, read from the records the
// router keeps there, beside what the chain says.
(router.stats as unknown as { flush?: () => void }).flush?.();
const provOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'providers', '--rpc', RPC], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const provLines = provOut.split('\n');
const ironAt = provLines.findIndex((l) => l.includes('Ironbridge Compute'));
const ironSaw = ironAt >= 0 ? provLines[ironAt + 1] ?? '' : '';
// The same record beside the price: from the running router, as an agent's quote tool reads it, and from the command
// line, read from the records the router keeps in its home.
const quoteSaid = (await (await fetch(`${ROUTER}/orrery/quote?model=llama-3.3-70b`)).json()) as { text?: string; rows?: { name: string; saw?: string | null }[] };
const quoteCli = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'quote', 'llama-3.3-70b', '--rpc', RPC], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
const quoteLine = (t: string) => t.split('\n').find((l) => l.startsWith('  Ironbridge Compute  ')) ?? '';
check('a quote says beside each price what this router saw of that node, from the running router and from the command line', /what your router saw of them:\n/.test(quoteSaid.text ?? '') && /^ {2}Ironbridge Compute {2}up in \d+ of \d+ checks this router made over /.test(quoteLine(quoteSaid.text ?? '')) && /up in \d+ of \d+ checks/.test(quoteSaid.rows?.find((r) => r.name === 'Ironbridge Compute')?.saw ?? '') && /^ {2}Ironbridge Compute {2}up in \d+ of \d+ checks/.test(quoteLine(quoteCli)), quoteLine(quoteSaid.text ?? '').trim().slice(0, 160) || 'no record under the prices');
// Both say too whether that node's bills stayed within the prices it listed, from the same log of answers.
const billsRecordRe = /(every bill was within its listed prices|its bill was within its listed prices|billed above its listed prices)/;
check('what your router saw of a node, in a quote and in orrery providers, says whether its bills stayed within its listed prices', billsRecordRe.test(quoteLine(quoteSaid.text ?? '')) && billsRecordRe.test(quoteLine(quoteCli)) && billsRecordRe.test(ironSaw), (quoteLine(quoteSaid.text ?? '').match(billsRecordRe)?.[0] ?? 'no bill record') + ' · providers: ' + (ironSaw.match(billsRecordRe)?.[0] ?? 'none'));
check('orrery providers shows under each node what your own router saw of it, from the records it keeps', /^ {4}what your router saw: up in \d+ of \d+ checks this router made over .+; answered (\d+ of \d+|all \d+) requests this router sent it over .+; first token in about \d+ ms lately(; [^;]+)?$/.test(ironSaw) && provLines.filter((l) => l.startsWith('    what your router saw:')).length >= 3,
  ironSaw.trim().slice(0, 170) || 'no line under Ironbridge');
if (process.env.E2E_HOLD) {
  console.log(`holding the network for ${process.env.E2E_HOLD}s before settlement: router console at ${ROUTER}/`);
  await sleep(Number(process.env.E2E_HOLD) * 1000);
}
console.log('\nsettlement');
const redeemTx: Record<string, string> = {};
// A node never paid out on chain sends its first payout at the next round of its own, below its usual floor, so its
// operator sees money land minutes after the first answer. Halo has a few millionths waiting and the default floor.
const haloNode = nodes[providerSpecs.findIndex((s) => s.name === 'Halo Compute')];
const haloCfg = haloNode.cfg as { redeem?: { everySecs?: number; minUnits?: number } };
const haloFloor = haloCfg.redeem;
haloCfg.redeem = { ...(haloFloor ?? {}), minUnits: 50_000 };
const haloPaidBefore = await conn.getAccountInfo(haloNode.pda).then((i) => (i ? decodeProvider(i.data).redeems : -1n));
const haloFirst = await ((haloNode as unknown as { redeemRound?: () => Promise<{ amount: bigint; tx: string }[]> }).redeemRound?.() ?? Promise.resolve(null)).catch((e: Error) => e.message);
const haloPaidAfter = await conn.getAccountInfo(haloNode.pda).then((i) => (i ? decodeProvider(i.data).redeems : -1n));
haloCfg.redeem = haloFloor;
if (Array.isArray(haloFirst)) for (const d of haloFirst) redeemTx[haloNode.pda.toBase58()] = d.tx;
check('a node never paid out on chain sends its first payout at its next round, below its usual $0.05 floor, so its operator sees money land',
  haloPaidBefore === 0n && Array.isArray(haloFirst) && haloFirst.length >= 1 && haloFirst.every((d) => d.amount < 50_000n) && haloPaidAfter >= 1n,
  Array.isArray(haloFirst) ? `Halo: ${haloPaidBefore} payouts before, ${haloFirst.length} sent now ($${haloFirst.map((d) => (Number(d.amount) / 1e6).toFixed(6)).join(', ')}), ${haloPaidAfter} on chain after` : `Halo: ${haloFirst ?? 'no redeemRound'}`);
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
  // What the node kept of its own payouts adds up to what the chain says it was paid, channel redeem for channel
  // redeem, and its status carries the last one: provider status prints it from there.
  const kept = readPayouts(join(WORK, 'providers', providerSpecs[i].name.split(' ')[0].toLowerCase(), 'payouts.jsonl'));
  const keptUnits = kept.reduce((a, p) => a + BigInt(p.units), 0n);
  const keptChannels = kept.reduce((a, p) => a + p.channels, 0);
  const lastKept = (n.status() as { payouts?: { last: { tx: string } } | null }).payouts?.last.tx;
  // And `provider earnings` says the same under what the window billed, for the node the command line can read.
  if (i === 1) {
    const earnOut = await cliOut(['earnings', '--since', '24h']);
    const earnPaid = earnOut.split('\n').find((l) => l.startsWith('paid out: ')) ?? '';
    check('orrery provider earnings says what reached the wallet in the same window, from the payouts the node keeps', earnPaid.startsWith(`paid out: $${usd(keptUnits)} to your wallet in ${kept.length} payout${kept.length === 1 ? '' : 's'} in the last 24h, the last `) && earnPaid.includes(`(tx ${kept[kept.length - 1]?.tx.slice(0, 12)}…)`), earnPaid || 'no such line');
    // And when the rest goes out, asked of the running node: what its console says under the payouts.
    const earnNext = earnOut.split('\n').find((l) => l.startsWith('next payout: ')) ?? '';
    const nodeNext = ((await import('../src/provider/payouts.ts')) as unknown as { nextPayoutSentence?: (x: unknown) => string }).nextPayoutSentence?.((n.status() as { nextPayout?: unknown }).nextPayout) ?? '';
    check('orrery provider earnings says when the rest goes out, as the running node counts it', !!nodeNext && earnNext.toLowerCase() === `next payout: ${nodeNext}`.toLowerCase(), earnNext || 'no such line');
    // By day: today's row is what the node's log of answers billed today and what its payouts sent today.
    const byDay = await cliOut(['earnings', '--by', 'day']);
    const todayUtc = new Date().toISOString().slice(0, 10), todayStart = Date.parse(`${todayUtc}T00:00:00Z`);
    const servedToday = readTrips(join(WORK, 'providers', 'ironbridge', 'served.jsonl')).filter((t) => t.at >= todayStart);
    const billedToday = servedToday.reduce((s, t) => s + BigInt(Math.round(Number(t.cost) * 1e6)), 0n);
    const paidToday = kept.filter((p) => p.at >= todayStart);
    const todayRow = byDay.split('\n').find((l) => l.startsWith(todayUtc)) ?? '';
    check('orrery provider earnings --by day says what each UTC day billed and paid out, from the node’s own files',
      todayRow.split(/\s+/).join(' ') === `${todayUtc} ${servedToday.length.toLocaleString('en-US')} $${usd(billedToday)} ${paidToday.length} $${usd(paidToday.reduce((s, p) => s + BigInt(p.units), 0n))}` && byDay.includes('by day (UTC)'),
      todayRow.trim().replace(/\s+/g, ' ') || 'no row for today');
    // The same books and the checked payouts as CSV, for a spreadsheet: nothing but the header and the rows.
    const daysCsv = (await cliOut(['earnings', '--by', 'day', '--csv'])).split('\n');
    const paysCsv = (await cliOut(['payouts', '--last', '50', '--csv'])).split('\n');
    const keptNewest = kept.slice().sort((a, b) => b.at - a.at).slice(0, 50);
    check('orrery provider earnings --by day --csv and provider payouts --csv give the books and the checked payouts as rows for a spreadsheet',
      daysCsv[0] === 'day_utc,answers,billed_usdc,payouts,paid_out_usdc' && daysCsv[1] === `${todayUtc},${servedToday.length},${usd(billedToday)},${paidToday.length},${usd(paidToday.reduce((s, p) => s + BigInt(p.units), 0n))}`
      && paysCsv[0] === 'time_utc,paid_out_usdc,channels,tx,on_chain,arrived_usdc,wallet_after_usdc' && paysCsv.length === keptNewest.length + 1
      && keptNewest.every((p, j) => paysCsv[j + 1].split(',')[3] === p.tx && paysCsv[j + 1].split(',')[4] === 'landed' && paysCsv[j + 1].split(',')[5] === usd(BigInt(p.units))),
      `${daysCsv[1] ?? 'no day row'} · ${paysCsv.length - 1} payout row(s), the first ${paysCsv[1]?.split(',').slice(4).join(',') ?? '—'}`);
    // By month: the same books added up by UTC calendar month, for the accounts. This month's row is its days summed.
    const monthCsv = (await cliOut(['earnings', '--by', 'month', '--since', '400d', '--csv'])).split('\n');
    const dayRows = (await cliOut(['earnings', '--by', 'day', '--since', '400d', '--csv'])).split('\n').slice(1).filter(Boolean).map((l) => l.split(','));
    const thisMonth = todayUtc.slice(0, 7), inMonth = dayRows.filter((r) => r[0].startsWith(thisMonth));
    const toUnits = (x: string) => BigInt(Math.round(Number(x) * 1e6));
    const wantMonth = `${thisMonth},${inMonth.reduce((a, r) => a + Number(r[1]), 0)},${usd(inMonth.reduce((a, r) => a + toUnits(r[2]), 0n))},${inMonth.reduce((a, r) => a + Number(r[3]), 0)},${usd(inMonth.reduce((a, r) => a + toUnits(r[4]), 0n))}`;
    const monthText = await cliOut(['earnings', '--by', 'month']);
    check('orrery provider earnings --by month adds the books up by UTC month for the accounts, as lines and as CSV',
      inMonth.length > 0 && monthCsv[0] === 'month_utc,answers,billed_usdc,payouts,paid_out_usdc' && monthCsv[1] === wantMonth && monthText.includes('by month (UTC)') && monthText.split('\n').some((l) => l.startsWith(`${thisMonth} `)),
      `${monthCsv[1] ?? 'no month row'} from ${inMonth.length} day(s)`);
    // And `provider payouts` looks each kept payout up on chain: what the transaction put in the wallet's USDC account
    // is what the node wrote down, for every one it shows.
    const payOut = await cliOut(['payouts', '--last', '50']);
    const shownKept = kept.slice().sort((a, b) => b.at - a.at).slice(0, 50);
    const shownUnits = shownKept.reduce((a, p) => a + BigInt(p.units), 0n);
    check('orrery provider payouts checks each kept payout against the chain: every one arrived in the wallet as kept', shownKept.length > 0 && payOut.split('\n').at(-1) === `${shownKept.length} of ${shownKept.length} arrived in your wallet as kept here, $${usd(shownUnits)} in all` && shownKept.every((p) => payOut.includes(`tx ${p.tx.slice(0, 12)}…  arrived $${usd(BigInt(p.units))}`)),
      payOut.split('\n').at(-1) || 'no output');
    // Each row says what the wallet then held, from the same record; the newest is what the wallet holds now.
    const newestRow = payOut.split('\n').find((l) => l.includes(`tx ${shownKept[0]?.tx.slice(0, 12)}…`)) ?? '';
    const walletNow = await balance(wallets[i].publicKey);
    check('orrery provider payouts says what the wallet held after each payout, and the newest is what the chain holds now', shownKept.length > 0 && newestRow.endsWith(`, wallet then $${usd(walletNow)}`),
      newestRow.trim().replace(/\s{2,}/g, ' ') || 'no such row');
  }
  if (acct.settled > 0n) check(`${providerSpecs[i].name} keeps each payout it sent: they add up to what the chain says it redeemed, and its status names the last`, keptUnits === acct.settled && BigInt(keptChannels) === acct.redeems && lastKept === kept[kept.length - 1]?.tx,
    `${kept.length} payout(s) kept, $${usd(keptUnits)} over ${keptChannels} channel redeem(s); chain $${usd(acct.settled)} over ${acct.redeems}`);
}

// The node's console lists those payouts with their transactions, and the last day's total under them.
const payMod = (await import('../src/provider/payouts.ts')) as unknown as { payoutRows?: (p: unknown) => string };
const ibPage = await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/?key=${ibKey}`)).text();
const ibRows = payMod.payoutRows?.((nodes[1].status() as { payouts?: unknown }).payouts ?? null) ?? '';
const ibLastTx = readPayouts(join(WORK, 'providers', 'ironbridge', 'payouts.jsonl')).at(-1)?.tx ?? 'no payout kept';
check('the node’s console lists each payout to the wallet with its transaction, and the last day’s total', ibPage.includes('id="payouts"') && ibPage.includes('const payoutRows=') && ibRows.includes(`title="${ibLastTx}"`) && ibRows.includes('<td>last 24 h</td>'),
  ibRows.replace(/title="[^"]+"/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'no rows');
// Each transaction there is a button that copies the whole signature, to look up on any explorer; the page links nowhere.
check('the node’s console copies each payout’s whole transaction for any explorer, and links to no other computer', ibRows.includes(`<button class=tx type=button data-tx="${ibLastTx}"`) && ibPage.includes('navigator.clipboard.writeText(tx)') && ibPage.includes('id="copied"') && !/<a\b[^>]*href="(?:https?:)?\/\//i.test(ibPage + ibRows),
  ibRows.match(/<button class=tx[^>]*>[^<]*<\/button>/)?.[0].replace(/data-tx="[^"]+"/, 'data-tx="…"') ?? 'no button');
// Each node read every payout it sent back from the chain on its own, said in its log that it arrived, and its status
// marks it for the console's "on chain" column, before anyone pressed the button below.
const arrivals = async () => providerSpecs.map((s, i) => {
  const kept = readPayouts(join(WORK, 'providers', s.name.split(' ')[0].toLowerCase(), 'payouts.jsonl'));
  const marked = ((nodes[i].status() as { payouts?: { checked?: Record<string, { units: string }> } | null }).payouts?.checked) ?? {};
  const said = (p: { units: string; tx: string }) => nodeSaid[i].find((l) => l.startsWith(`$${usd(BigInt(p.units))} arrived in your wallet: the chain's record of tx ${p.tx.slice(0, 12)}… shows it in your USDC account`));
  const told = kept.filter((p) => said(p) && marked[p.tx]?.units === p.units);
  const lastKept = kept.slice().sort((a, b) => a.at - b.at).at(-1);
  return { kept: kept.length, told: told.length, held: lastKept ? said(lastKept)?.match(/, which then held \$([0-9.]+)$/)?.[1] ?? null : null };
});
let arrived = await arrivals();
for (let t = 0; t < 20 && arrived.some((a) => a.told < a.kept); t++) {
  await new Promise((r) => setTimeout(r, 500));
  arrived = await arrivals();
}
check('each node reads every payout it sent back from the chain on its own and says it arrived in the wallet', arrived.some((a) => a.kept > 0) && arrived.every((a) => a.told === a.kept),
  arrived.map((a, i) => `${providerSpecs[i].name.split(' ')[0]} ${a.told}/${a.kept}`).join(', '));
// Kestrel's payouts also went to its notify webhook, each as the line its log said, with the amount the chain shows.
const kestrelKept = readPayouts(join(WORK, 'providers', 'kestrel', 'payouts.jsonl'));
const notices = () => hooked.filter((h) => h.path === '/hooks/kestrel' && h.body.payout);
for (let t = 0; t < 20 && notices().length < kestrelKept.length; t++) await new Promise((r) => setTimeout(r, 250));
const noticeFor = (p: { tx: string; units: string }) => notices().filter((h) => h.body.payout!.tx === p.tx);
const loggedFor = (p: { tx: string }) => nodeSaid[0].find((l) => l.includes(`tx ${p.tx.slice(0, 12)}…`) && l.includes('arrived in your wallet'));
check('a node with a notify webhook posts each payout’s arrival there, the line its log says, with the amount the chain shows', kestrelKept.length > 0
  && kestrelKept.every((p) => noticeFor(p).length === 1 && noticeFor(p)[0].body.payout!.arrived === usd(BigInt(p.units)) && noticeFor(p)[0].body.text === `${providerSpecs[0].name}: ${loggedFor(p)}` && noticeFor(p)[0].body.content === noticeFor(p)[0].body.text),
  `${notices().length} notices for ${kestrelKept.length} payouts${notices()[0] ? `: ${notices()[0].body.text!.slice(0, 96)}…` : ''}`);
// Its status, which the console and provider status read, says where notices go and that the last got through, and
// gives the webhook's host only: the rest of the address is as good as a password to post in that channel.
const kNotify = (nodes[0].status() as { notify?: { host: string; last: { what: string; status: number | null } | null } | null }).notify;
check('a node’s status says where payout notices go and that the last one got through, without the webhook’s secret path',
  kNotify?.host === new URL(HOOK).host && kNotify?.last?.what === 'payout' && kNotify?.last?.status === 200 && !JSON.stringify(nodes[0].status()).includes('/hooks/kestrel'),
  kNotify ? `${kNotify.host} · last ${kNotify.last ? `${kNotify.last.what} HTTP ${kNotify.last.status}` : 'none'}` : 'no notify in status');
// The line for each node's latest payout says what its wallet then held, from the same record: what the wallet holds now.
const heldNow = await Promise.all(providerSpecs.map((_, i) => balance(wallets[i].publicKey)));
check('each node says what its wallet held after its latest payout, and the chain agrees', arrived.some((a) => a.kept > 0) && arrived.every((a, i) => a.kept === 0 || a.held === usd(heldNow[i])),
  arrived.map((a, i) => `${providerSpecs[i].name.split(' ')[0]} said $${a.held ?? '—'}, chain $${usd(heldNow[i])}`).join(', '));
// The status the console reads carries the same figure, kept in the node's folder so a restart does not lose it.
const statusWallet = providerSpecs.map((_, i) => (nodes[i].status() as { wallet?: { units: string } | null }).wallet ?? null);
check('each node’s status carries what its wallet held after its latest payout, per the chain, for the console', arrived.some((a) => a.kept > 0) && arrived.every((a, i) => a.kept === 0 || statusWallet[i]?.units === heldNow[i].toString()),
  statusWallet.map((w, i) => `${providerSpecs[i].name.split(' ')[0]} $${w ? usd(BigInt(w.units)) : '—'}`).join(', '));
// And `provider status`, for a node on a server with no browser, says the same of the last payout.
const ironStatusText = await cliOut(['status']);
const lastPaidLine = ironStatusText.split('\n').find((l) => /^\s+last payout\s/.test(l)) ?? '';
const ironLastKept = readPayouts(join(WORK, 'providers', 'ironbridge', 'payouts.jsonl')).sort((a, b) => b.at - a.at)[0];
check('orrery provider status says the last payout arrived, once the node has read it back from the chain', !!ironLastKept && lastPaidLine.includes(`tx ${ironLastKept.tx.slice(0, 12)}…`) && lastPaidLine.endsWith('  arrived, per the chain'), lastPaidLine.trim() || 'no such line');
// And what the wallet held right after it, as the console shows it: what the chain holds in that wallet now.
const walletSaid = ironStatusText.split('\n').find((l) => /^\s+in your wallet\s/.test(l)) ?? '';
check('orrery provider status says what the wallet held after the last payout, per the chain', !!ironLastKept && walletSaid === `  in your wallet        $${usd(heldNow[1])} after the last payout, per the chain (tx ${ironLastKept.tx.slice(0, 12)}…)`, walletSaid.trim() || 'no such line');
// When the UTC date moves on, the node says the day that ended in one line of its log: what it billed (its log of
// answers), what it paid out (its payouts) and what the wallet then held (the chain, which agrees now).
{
  const today = new Date().toISOString().slice(0, 10), dayStart = Date.parse(`${today}T00:00:00Z`);
  const servedToday = readTrips(join(WORK, 'providers', 'ironbridge', 'served.jsonl')).filter((t) => t.at >= dayStart);
  const paidToday = readPayouts(join(WORK, 'providers', 'ironbridge', 'payouts.jsonl')).filter((p) => p.at >= dayStart);
  const billedToday = servedToday.reduce((n, t) => n + BigInt(Math.round(Number(t.cost) * 1e6)), 0n);
  const paidUnits = paidToday.reduce((n, p) => n + BigInt(p.units), 0n);
  const before = nodeSaid[1].length;
  (nodes[1] as unknown as { booksTick?: (now: number) => void }).booksTick?.(dayStart + 86_400_000 + 1_000);
  const booksSaid = nodeSaid[1].slice(before).find((l) => l.startsWith('books for ')) ?? '';
  check('just after midnight UTC, the node says the day’s books in one line: billed, paid out, and what the wallet then held per the chain',
    booksSaid === `books for ${today} (UTC): ${servedToday.length.toLocaleString('en-US')} answer${servedToday.length === 1 ? '' : 's'}, $${usd(billedToday)} billed; ${paidToday.length} payout${paidToday.length === 1 ? '' : 's'}, $${usd(paidUnits)} to your wallet; it held $${usd(heldNow[1])} after the last, per the chain`,
    booksSaid || 'no such line');
  // And it keeps the closed day's totals in days.jsonl, which does not roll over with the logs: a day the logs no longer
  // reach (here one kept three days back, before this rehearsal's logs begin) still shows in the books by day.
  const daysPath = join(WORK, 'providers', 'ironbridge', 'days.jsonl');
  const keptToday = existsSync(daysPath) ? readFileSync(daysPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { day: string; answers: number; billed: string; payouts: number; paid: string }).find((d) => d.day === today) : undefined;
  const oldDay = new Date(dayStart - 3 * 86_400_000).toISOString().slice(0, 10);
  appendFileSync(daysPath, `${JSON.stringify({ day: oldDay, answers: 41, billed: '123456', payouts: 2, paid: '120000' })}\n`);
  const weekBooks = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/books?since=7d`, { headers: { 'x-orrery-console-key': ibKey } }).then((r) => r.json()).catch(() => null) as { rows?: { day: string; answers: number; billed: string; paid: string }[] } | null;
  const oldRow = weekBooks?.rows?.find((r) => r.day === oldDay);
  check('the node keeps each closed day’s totals, and the books by day show a day its rolled-over logs no longer hold',
    !!keptToday && keptToday.answers === servedToday.length && keptToday.billed === billedToday.toString() && keptToday.payouts === paidToday.length && keptToday.paid === paidUnits.toString()
    && !!oldRow && oldRow.answers === 41 && oldRow.billed === '0.123456' && oldRow.paid === '0.120000',
    `${keptToday ? `kept ${keptToday.day}: ${keptToday.answers} answers, ${keptToday.payouts} payouts` : 'nothing kept'} · ${oldRow ? `${oldRow.day} from days.jsonl: ${oldRow.answers} answers` : 'no old day shown'}`);
  // Under the books the console says this UTC month so far: every day of the month the node has, kept days included.
  const yearBooks = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/books?since=400d`, { headers: { 'x-orrery-console-key': ibKey } }).then((r) => r.json()).catch(() => null) as { rows?: { day: string; answers: number; billed: string; payouts: number; paid: string }[] } | null;
  const monthKey = today.slice(0, 7), monthDays = (yearBooks?.rows ?? []).filter((r) => r.day.startsWith(monthKey));
  const mo = (weekBooks as { month?: { day: string; answers: number; billed: string; payouts: number; paid: string; line: string } } | null)?.month;
  const sumUnits = (k: 'billed' | 'paid') => monthDays.reduce((a, r) => a + BigInt(Math.round(Number(r[k]) * 1e6)), 0n);
  check('the node’s console says this UTC month so far under its books: every day of the month it has, kept days included',
    !!mo && mo.day === monthKey && monthDays.length > 0 && mo.answers === monthDays.reduce((a, r) => a + r.answers, 0) && mo.billed === usd(sumUnits('billed')) && mo.payouts === monthDays.reduce((a, r) => a + r.payouts, 0) && mo.paid === usd(sumUnits('paid'))
    && mo.line.endsWith(`so far (UTC): ${mo.answers.toLocaleString('en-US')} answer${mo.answers === 1 ? '' : 's'}, $${mo.billed} billed; ${mo.payouts} payout${mo.payouts === 1 ? '' : 's'}, $${mo.paid} paid out to your wallet`)
    && ibPage.includes('id="month"'),
    mo?.line ?? 'no month in /orrery/books');
}
// Kestrel has a notify webhook: past midnight UTC the same line goes there too, with the day's totals beside it.
{
  const today = new Date().toISOString().slice(0, 10), dayStart = Date.parse(`${today}T00:00:00Z`);
  const servedToday = readTrips(join(WORK, 'providers', 'kestrel', 'served.jsonl')).filter((t) => t.at >= dayStart);
  const before = nodeSaid[0].length;
  (nodes[0] as unknown as { booksTick?: (now: number) => void }).booksTick?.(dayStart + 86_400_000 + 1_000);
  const said = nodeSaid[0].slice(before).find((l) => l.startsWith('books for ')) ?? '';
  const booksNotices = () => hooked.filter((h) => h.path === '/hooks/kestrel' && (h.body as { books?: unknown }).books);
  for (let t = 0; t < 20 && !booksNotices().length; t++) await new Promise((r) => setTimeout(r, 250));
  const got = booksNotices()[0]?.body as { text?: string; content?: string; books?: { day: string; answers: number } } | undefined;
  check('just after midnight UTC, a node with a notify webhook posts the day’s books there, the line its log says',
    !!said && booksNotices().length === 1 && got?.text === `${providerSpecs[0].name}: ${said}` && got?.content === got?.text && got?.books?.day === today && got?.books?.answers === servedToday.length,
    got?.text?.slice(0, 120) ?? (said ? 'said in the log, nothing posted' : 'no books line'));
}
// Its "check against the chain" reads each listed payout's transaction from the chain: what reached the wallet is what
// the node kept, and the line under the table says so. Without the console key it is not there.
const ibKept = readPayouts(join(WORK, 'providers', 'ironbridge', 'payouts.jsonl')).sort((a, b) => b.at - a.at).slice(0, 12);
const ibCheck = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/payouts/check`, { headers: { 'x-orrery-console-key': ibKey } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { rows?: { tx: string; state: string; units: string | null }[]; line?: string | null } | null;
const ibCheckNoKey = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/payouts/check`).then((r) => r.status).catch(() => 0);
const ibKeptUnits = ibKept.reduce((a, p) => a + BigInt(p.units), 0n);
check('the node’s console checks each payout against the chain: every one arrived in the wallet as kept, and only with the key', ibKept.length > 0 && ibCheckNoKey === 404
  && ibCheck?.rows?.length === ibKept.length && ibCheck.rows.every((r, j) => r.tx === ibKept[j].tx && r.state === 'landed' && r.units === ibKept[j].units)
  && ibCheck.line === `${ibKept.length} of ${ibKept.length} arrived in your wallet as kept here, $${usd(ibKeptUnits)} in all`,
  ibCheck?.line ?? `no answer (without the key: ${ibCheckNoKey})`);
// The console's week of books comes from the node's files: today's row is what its log billed and its payouts sent
// today, only with the key. And the console's two-second polling reads the listing from the chain at most once a minute.
{
  const day = new Date().toISOString().slice(0, 10), start = Date.parse(`${day}T00:00:00Z`);
  const books = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/books?since=7d`, { headers: { 'x-orrery-console-key': ibKey } }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { rows?: { day: string; answers: number; billed: string; payouts: number; paid: string }[] } | null;
  const booksNoKey = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/books`).then((r) => r.status).catch(() => 0);
  const servedToday = readTrips(join(WORK, 'providers', 'ironbridge', 'served.jsonl')).filter((t) => t.at >= start);
  const paidToday = readPayouts(join(WORK, 'providers', 'ironbridge', 'payouts.jsonl')).filter((p) => p.at >= start);
  const row = books?.rows?.find((r) => r.day === day);
  check('the node’s console shows its books by day, from its own files, and only with the key', booksNoKey === 404 && !!row && row.answers === servedToday.length
    && row.billed === usd(servedToday.reduce((s, t) => s + BigInt(Math.round(Number(t.cost) * 1e6)), 0n)) && row.payouts === paidToday.length && row.paid === usd(paidToday.reduce((s, p) => s + BigInt(p.units), 0n)),
    row ? `${row.day}: ${row.answers} answers, $${row.billed} billed, ${row.payouts} payouts, $${row.paid} paid out` : `no row (without the key: ${booksNoKey})`);
  // The console's "Download CSV" link: the same rows as a file, from the node, only with the key.
  const csvRes = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/books?since=90d&format=csv&key=${ibKey}`).catch(() => null);
  const csvText = csvRes?.ok ? await csvRes.text() : '';
  const csvNoKey = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/books?format=csv`).then((r) => r.status).catch(() => 0);
  check('the node’s console downloads its books as a CSV file, only with the key', csvNoKey === 404 && csvRes?.headers.get('content-type')?.startsWith('text/csv') === true && csvRes.headers.get('content-disposition') === 'attachment; filename="orrery-books.csv"'
    && csvText.split('\n')[0] === 'day_utc,answers,billed_usdc,payouts,paid_out_usdc' && !!row && csvText.split('\n')[1] === `${row.day},${row.answers},${row.billed},${row.payouts},${row.paid}`,
    csvText.split('\n')[1] ?? `no file (without the key: ${csvNoKey})`);
  const conn = nodes[1].conn as unknown as { getAccountInfo: (...a: unknown[]) => Promise<unknown> };
  const real = conn.getAccountInfo.bind(conn);
  const balanceConn = nodes[1].conn as unknown as { getBalance: (...a: unknown[]) => Promise<unknown> };
  const realBalance = balanceConn.getBalance.bind(balanceConn);
  let reads = 0, refreshes = 0;
  conn.getAccountInfo = (...a: unknown[]) => { reads++; return real(...a); };
  balanceConn.getBalance = (...a: unknown[]) => { refreshes++; return realBalance(...a); };
  let lastEarn: { fees?: { line: string; low: boolean } | null } | null = null;
  for (let k = 0; k < 5; k++) lastEarn = await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/earnings?since=24h`, { headers: { 'x-orrery-console-key': ibKey } }).then((r) => r.json()).catch(() => null);
  conn.getAccountInfo = real;
  balanceConn.getBalance = realBalance;
  check('the console polling the node’s earnings reads the chain at most once a minute', refreshes <= 1 && reads <= 2 * refreshes, `${refreshes} refresh${refreshes === 1 ? '' : 'es'}, ${reads} account read${reads === 1 ? '' : 's'} for 5 polls`);
  // The fee money the node key has for payouts, as the console shows it: the key's balance on chain now.
  const { feesLine } = (await import('../src/provider/node.ts')) as unknown as { feesLine: (o: { lamports: number; openingRent: number | null; nodeKey: string }) => string };
  const keyLamports = (await realBalance(nodes[1].node.publicKey)) as number;
  const expectedFees = feesLine({ lamports: keyLamports, openingRent: null, nodeKey: nodes[1].node.publicKey.toBase58() });
  check('the node’s console says how much fee money its key has for payouts, from the chain', lastEarn?.fees?.line === expectedFees && lastEarn.fees.low === false, lastEarn?.fees?.line ?? 'no fee line');
}

const iron = nodes[1];
const ironCh = channels.get(iron.pda.toBase58())!;
const before = await balance(user.publicKey);
const vaultBefore = (await getAccount(conn, pda.ata(new PublicKey(ironCh.channel), usdc))).amount;
await sendAndConfirmTransaction(conn, new Transaction().add(ins.closeChannel(iron.node.publicKey, wallets[1].publicKey, new PublicKey(ironCh.channel), user.publicKey, usdc)), [iron.node]);
const after = await balance(user.publicKey);
check('a provider releasing its channel sends the rest straight back to the user', after - before === vaultBefore, `refund $${usd(vaultBefore)}`);
// The node no longer has that channel. Once its own record of it is past its 30 seconds, it says so; the router's
// next request to it must go through on a fresh channel, not fail until the router's own check comes round.
const ironLedger = (iron as unknown as { ledger: Map<string, { checkedAt: number }> }).ledger.get(ironCh.channel);
if (ironLedger) ironLedger.checkedAt = 0;
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const afterRelease = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': iron.pda.toBase58(), 'x-orrery-patience': '0' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const afterReleaseSaid = await afterRelease.text();
const freshCh = channels.get(iron.pda.toBase58())?.channel ?? '';
const freshOnChain = freshCh ? !!(await conn.getAccountInfo(new PublicKey(freshCh))) : false;
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
check('after a node releases a router’s channel, the next request to it goes through on a fresh channel', afterRelease.status === 200 && freshCh !== ironCh.channel && freshOnChain, `${afterRelease.status}${afterRelease.status === 200 ? '' : ` (${afterReleaseSaid.slice(0, 120)})`} · channel ${ironCh.channel.slice(0, 6)} released → ${freshCh === ironCh.channel ? 'still the released one' : `${freshCh.slice(0, 6)}, ${freshOnChain ? 'on chain' : 'not on chain'}`}`);

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

// A node operator's own readiness check, run on two of the rehearsal's nodes.
const { providerCheck, renderCheck } = await import('../src/provider/check.ts');
const ironCheck = await providerCheck(iron);
const haloCheck = await providerCheck(nodes[3]);
const hellosBefore = hooked.filter((h) => h.body.payout === null).length;
const kestrelNotify = (await providerCheck(nodes[0])).find((l) => l.what === 'payout notices');
const hello = hooked.filter((h) => h.body.payout === null).slice(hellosBefore);
check('provider check sends the notify webhook one test notice and says it got through', kestrelNotify?.ok === true && hello.length === 1 && hello[0].path === '/hooks/kestrel' && !!hello[0].body.text?.startsWith(`${providerSpecs[0].name}: orrery provider check says hello`),
  kestrelNotify ? `${kestrelNotify.ok ? '✓' : '✗'} ${kestrelNotify.detail}` : 'no payout notices line');
console.log(renderCheck('Ironbridge Compute', ironCheck).split('\n').map((l) => `    ${l}`).join('\n'));
console.log(renderCheck('Halo Compute', haloCheck).split('\n').map((l) => `    ${l}`).join('\n'));
const lineOf = (ls: { what: string; ok: boolean | null; detail: string }[], w: string) => ls.find((l) => l.what === w);
// Where each price stands: read from the same listings a router on this cluster reads, Ironbridge against the
// others, and Halo's one model, which nobody else lists.
const priceSight = new Registry(conn, { allowDev: true, measurements: [] });
await priceSight.refresh();
const { compare: comparePrices } = await import('../src/provider/compare.ts');
const ironStands = comparePrices(iron.cfg.models.map((m) => ({ id: m.id, price: m.price })), priceSight.usable(), iron.pda.toBase58()).slice(0, 4);
const ironPrices = lineOf(ironCheck, 'prices')?.detail ?? '';
const haloPrices = lineOf(haloCheck, 'prices')?.detail ?? '';
check('orrery provider check says where each model’s price stands among the other listings of it, and points to provider price when some list it cheaper',
  haloPrices === 'a 2,000-in / 500-out request: gemma-3-27b listed by no other node' && ironStands.length > 0 && ironStands.every((r) => ironPrices.includes(!r.others ? `${r.model} listed by no other node` : !r.cheaper ? `${r.model} the cheapest of ${r.others + 1}` : r.others === 1 ? `${r.model} at $${usd(r.myCost)}, the one other listing cheaper at $${usd(r.lowestCost!)}` : `${r.model} at $${usd(r.myCost)}, ${r.cheaper} of ${r.others} other listings cheaper`)) && ironPrices.endsWith('orrery provider price suggests prices under the cheapest') === ironStands.some((r) => r.cheaper > 0),
  ironPrices.slice(0, 200) || 'no prices line');
// Registering from the command line with a wallet that has no SOL: stopped before anything is sent, with what a
// listing takes, and the size the rent is worked out from is the size of a real listing.
const brokeDir = join(WORK, 'providers', 'broke');
mkdirSync(brokeDir, { recursive: true });
const brokeWallet = Keypair.generate();
writeFileSync(join(brokeDir, 'wallet.json'), JSON.stringify(Array.from(brokeWallet.secretKey)));
writeFileSync(join(brokeDir, 'provider.json'), JSON.stringify({ ...nodes[1].cfg, name: 'Broke Node', listen: 17289, publicUrl: 'https://gpu.example.org', wallet: join(brokeDir, 'wallet.json'), dataDir: brokeDir, burn: undefined, authority: undefined }));
const brokeOut = await new Promise<{ code: number | null; text: string }>((done) => { let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'register', '--config', join(brokeDir, 'provider.json'), '--rpc', RPC], { stdio: ['ignore', 'pipe', 'pipe'] }); pc.stdout!.on('data', (c) => (text += c)); pc.stderr!.on('data', (c) => (text += c)); pc.on('exit', (code) => done({ code, text })); });
const brokeListed = await conn.getAccountInfo(pda.provider(brokeWallet.publicKey));
// Started anyway, a node that is not listed says so once it is up: no router can find it, and it would wait in silence.
const startedUnlisted = await new Promise<string>((done) => { let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'start', '--config', join(brokeDir, 'provider.json'), '--rpc', RPC], { stdio: ['ignore', 'pipe', 'pipe'] }); pc.stdout!.on('data', (c) => { text += c; if (/\n(next|ready)[: ]/.test(`\n${text}`)) pc.kill(); }); const t = setTimeout(() => pc.kill(), 25_000); pc.on('exit', () => { clearTimeout(t); done(text); }); });
// A monitor runs the check with --json and reads the exit code: a node that is not ready has to say so there too.
const checkJson = await new Promise<{ code: number | null; text: string }>((done) => { let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'check', '--json', '--config', join(brokeDir, 'provider.json'), '--rpc', RPC], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (text += c)); pc.on('exit', (code) => done({ code, text })); });
const checkJsonLines = (() => { try { return JSON.parse(checkJson.text) as { ok: boolean | null; what: string }[]; } catch { return null; } })();
// Before it lists, the operator is told what a listing costs on this cluster: the rent for an account that size.
const unlistedLine = (checkJsonLines ?? []).find((l) => l.what === 'listing') as { detail?: string } | undefined;
const listingRent = await conn.getMinimumBalanceForRentExemption((await conn.getAccountInfo(nodes[1].pda))!.data.length);
check('orrery provider check says what listing will cost, from the rent on the cluster it is talking to', new RegExp(`takes about ${((listingRent + 10_000) / 1e9).toFixed(4).replace('.', '\\.')} SOL once`).test(unlistedLine?.detail ?? ''), (unlistedLine?.detail ?? 'no listing line').slice(-90));
check('orrery provider check --json exits 1 for a node that is not ready, with the lines as JSON', checkJson.code === 1 && Array.isArray(checkJsonLines) && checkJsonLines.some((l) => l.what === 'listing' && l.ok === false), `exit ${checkJson.code} · ${Array.isArray(checkJsonLines) ? `${checkJsonLines.filter((l) => l.ok === false).length} of ${checkJsonLines.length} lines failing` : 'output is not JSON'}`);
check('orrery provider start says what is left before the node earns: one that is not listed yet does not wait in silence', /\nnext: list the node on chain: orrery provider register --config /.test(`\n${startedUnlisted}`), (startedUnlisted.split('\n').find((l) => /^(next|ready)/.test(l)) ?? 'started without a word about it').slice(0, 150));
const realListingBytes = (await conn.getAccountInfo(nodes[1].pda))!.data.length;
const { LISTING_BYTES: listingBytes } = (await import('../src/provider/check.ts')) as unknown as { LISTING_BYTES?: number };
check('orrery provider register stops before sending when the wallet cannot pay for the listing, and says how much it takes', brokeOut.code === 1 && /has 0\.0000 SOL\. Listing a node takes about 0\.00\d+ SOL, once/.test(brokeOut.text) && !brokeListed && listingBytes === realListingBytes, `exit ${brokeOut.code} · ${brokeOut.text.trim().split('\n').pop()?.replace(brokeWallet.publicKey.toBase58(), '<wallet>').slice(0, 150) ?? 'nothing printed'} · a real listing is ${realListingBytes} bytes, the rent is worked out for ${listingBytes ?? 'no size'}`);
// The check ends with the one next thing to do. Halo's model server is off; that comes before anything else.
const { nextStep: nextOf } = (await import('../src/provider/check.ts')) as unknown as { nextStep?: (ls: unknown[], at: { config: string; publicUrl: string; nodeKey: string }) => string };
const haloNext = nextOf?.(haloCheck, { config: 'provider.json', publicUrl: nodes[3].cfg.publicUrl, nodeKey: nodes[3].node.publicKey.toBase58() }) ?? 'no next step';
check('orrery provider check ends with the one next thing to do', /^next: start your model server: /.test(haloNext), haloNext.slice(0, 140));
const ironFolder = lineOf(ironCheck, 'data folder');
check('orrery provider check says where the node keeps what it is owed and has not redeemed, and how much is there', ironFolder?.ok === true && ironFolder.detail.includes(join(WORK, 'providers')) && /\$\d+\.\d{6} waiting there/.test(ironFolder.detail), ironFolder?.detail ?? 'no such line');
const ironModelTest = lineOf(ironCheck, 'model test');
check('orrery provider check sends each listed model one small request, straight to the model server, and says it answered', ironModelTest?.ok === true && /answered a test request in \d+ ms/.test(ironModelTest.detail) && !lineOf(haloCheck, 'model test'), ironModelTest ? ironModelTest.detail.slice(0, 150) : 'the check does not test the models');
check('orrery provider check tells an operator whether the node is ready to earn', lineOf(ironCheck, 'model server')?.ok !== false && lineOf(ironCheck, 'listing')?.ok === true && lineOf(ironCheck, 'node key')?.ok === true && !!lineOf(ironCheck, 'burn pledge') && lineOf(haloCheck, 'model server')?.ok === false, `Ironbridge: ${ironCheck.filter((l) => l.ok === true).length} ready, ${ironCheck.filter((l) => l.ok === false).length} to fix · Halo (model server stopped): ${lineOf(haloCheck, 'model server')?.detail}`);

// The same check, from behind a front that drops the signed flag from /v1/wire the way a hosting platform could: the
// operator is told, since from then on new routers send that node the channel in headers.
const stripFront = createHttpServer((req, res) => {
  const out = httpRequest({ host: '127.0.0.1', port: providerSpecs[1].port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    if (req.url !== '/v1/wire') {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
      return;
    }
    let raw = '';
    r.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    r.on('end', () => {
      const j = JSON.parse(raw) as Record<string, unknown>;
      delete j.insideSig;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    });
  });
  out.on('error', () => res.writeHead(502).end());
  req.pipe(out);
});
await new Promise<void>((done) => stripFront.listen(0, '127.0.0.1', () => done()));
const behindStrip = Object.assign(Object.create(iron) as typeof iron, { cfg: { ...iron.cfg, publicUrl: `http://127.0.0.1:${(stripFront.address() as { port: number }).port}` } });
const stripCheck = await providerCheck(behindStrip);
// provider check reads the price list from the public address, as a router does, and fails the way a router would.
const behindStale = Object.assign(Object.create(iron) as typeof iron, { cfg: { ...iron.cfg, publicUrl: `http://127.0.0.1:${stalePort}` } });
const staleCheck = await providerCheck(behindStale);
staleNode.close();
check('orrery provider check fetches the price list a router would read, and fails when the public address serves another than the chain has', lineOf(staleCheck, 'manifest')?.ok === false && /is not the one on chain, so routers refuse this node/.test(lineOf(staleCheck, 'manifest')?.detail ?? '') && lineOf(ironCheck, 'manifest') === undefined && staleOwnCheck === '1', (lineOf(staleCheck, 'manifest')?.detail ?? 'no manifest line').replace(/http:\/\/127\.0\.0\.1:\d+/, '<node>').slice(0, 130));
stripFront.close();
const wireDirect = lineOf(ironCheck, 'wire key'), wireStripped = lineOf(stripCheck, 'wire key');
const haloWire = lineOf(haloCheck, 'wire key');
check('orrery provider check says whether payment inside is listed in the price list on chain, and how to list it', /listed in your price list on chain/.test(haloWire?.detail ?? '') && /paymentInside/.test(wireDirect?.detail ?? ''), `Halo: ${haloWire?.detail ?? 'no line'} · Ironbridge: ${wireDirect?.detail ?? 'no line'}`);
check('orrery provider check reads the node’s wire key from its public address as routers do, and says when something in front drops the signed flag', wireDirect?.ok === true && wireStripped?.ok === false && /drops/.test(wireStripped.detail), `direct: ${wireDirect?.detail ?? 'no such line'} · behind a front that drops it: ${wireStripped?.detail ?? 'no such line'}`);

// Burn on every answer: Ironbridge pledged 25% of what it redeems. A local desk stands in for the market (the admin
// sells the stand-in token at 2,500 per USDC in one transaction both sign); the burn itself is a real token burn.
const ironWallet = wallets[1];
const ironOrey = await getOrCreateAssociatedTokenAccount(conn, admin, orey, ironWallet.publicKey);
const ironUsdc = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, ironWallet.publicKey);
const adminUsdc = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, admin.publicKey);
iron.burnHooks = {
  swap: async (u) => {
    const tokens = u * 2_500n;
    const tx = await sendAndConfirmTransaction(conn, new Transaction().add(createTransferInstruction(ironUsdc.address, adminUsdc.address, ironWallet.publicKey, u), createTransferInstruction(adminOrey.address, ironOrey.address, admin.publicKey, tokens)), [ironWallet, admin]);
    return { tx, tokens };
  },
  burn: splBurner(conn, ironWallet, orey, 6),
};
const supplyBefore = BigInt((await conn.getTokenSupply(orey)).value.amount);
const ironSettled = decodeProvider((await conn.getAccountInfo(iron.pda))!.data).settled;
const burnReceipt = await iron.burnDue();
const supplyAfter = BigInt((await conn.getTokenSupply(orey)).value.amount);
const burnsServed = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/burns`)).json()) as { share: number; spent: string; burned: string; receipts: { burnTx: string }[] };
const burnTxInfo = burnReceipt ? await conn.getParsedTransaction(burnReceipt.burnTx, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }) : null;
const burnIx = burnTxInfo?.transaction.message.instructions.find((i) => 'parsed' in i && i.parsed?.type === 'burnChecked') as { parsed: { info: { mint: string; authority: string; tokenAmount: { amount: string } } } } | undefined;
const pledged = (ironSettled * 2_500n) / 10_000n;
check('a node that pledged a share of what it redeems buys the network token and burns it, and the supply on chain drops by exactly that', !!burnReceipt && BigInt(burnReceipt.usdc) === pledged && supplyBefore - supplyAfter === BigInt(burnReceipt.burned) && burnIx?.parsed.info.mint === orey.toBase58() && burnIx.parsed.info.authority === ironWallet.publicKey.toBase58() && BigInt(burnIx.parsed.info.tokenAmount.amount) === BigInt(burnReceipt.burned) && burnsServed.share === 2_500 && burnsServed.receipts.length === 1 && (await iron.burnDue()) === null, burnReceipt ? `Ironbridge redeemed $${usd(ironSettled)}, pledged 25% → spent $${usd(pledged)}, burned ${(Number(burnReceipt.burned) / 1e6).toLocaleString('en-US')} tokens · supply ${(Number(supplyBefore) / 1e6).toLocaleString('en-US')} → ${(Number(supplyAfter) / 1e6).toLocaleString('en-US')} · burn tx ${burnReceipt.burnTx.slice(0, 12)}…` : 'no burn');

await registry.refresh();
await registry.checkBurns(usdc, orey);
const ironSeen = registry.entries.get(iron.pda.toBase58())?.burn;
check('the router verifies a node’s burns on chain itself and scores the pledge as kept', !!ironSeen && !!burnReceipt && ironSeen.share === 2_500 && ironSeen.burned === BigInt(burnReceipt.burned) && ironSeen.spent === pledged && ironSeen.kept === 1 && ironSeen.receipts === 1, ironSeen ? `router read 1 receipt, checked the buy and the burn on chain: $${usd(ironSeen.spent)} spent of $${usd(pledged)} pledged, ${ironSeen.burned} token units burned, pledge kept ${(ironSeen.kept * 100).toFixed(0)}%` : 'nothing verified');
const burnAsk = (model: string) => fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const viaBurn = await burnAsk('llama-3.3-70b:burn');
const viaBurnJ = (await viaBurn.json()) as { error?: { message?: string } };
const noBurn = await burnAsk('qwen3-32b:burn');
const noBurnJ = (await noBurn.json()) as { error?: { message?: string } };
const burnCost = Number(viaBurn.headers.get('x-orrery-cost'));
check('the :burn route sends a request only to nodes whose burns the router verified, and the answer says what it sends to the burn', viaBurn.status === 200 && viaBurn.headers.get('x-orrery-provider') === iron.pda.toBase58() && viaBurn.headers.get('x-orrery-burn-share') === '2500' && Math.abs(Number(viaBurn.headers.get('x-orrery-burn')) - burnCost / 4) < 0.0000011 && noBurn.status === 503 && /burn pledge/.test(noBurnJ.error?.message ?? ''), `llama-3.3-70b:burn → Ironbridge · x-orrery-cost ${viaBurn.headers.get('x-orrery-cost')} · x-orrery-burn ${viaBurn.headers.get('x-orrery-burn')} (25%) · qwen3-32b:burn → ${noBurn.status}: ${noBurnJ.error?.message ?? viaBurnJ.error?.message}`);

// Private only: a second router over the same network that seals everything or refuses, whatever the request asks for.
const lockedRouter = new Router({ port: 17172, route: 'auto', minReputation: 0, registry, channels, conn, refreshSecs: 3_600, log: () => undefined, privateOnly: true });
await lockedRouter.start();
const lockedAsk = (model: string, header: Record<string, string> = {}) => fetch('http://127.0.0.1:17172/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...header }, body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const lockedCheap = await lockedAsk('llama-3.3-70b:cheap', { 'x-orrery-route': 'price' });
await lockedCheap.json();
const lockedNone = await lockedAsk('deepseek-v3');
const lockedNoneJ = (await lockedNone.json()) as { error?: { message?: string } };
await lockedRouter.close();
check('a private-only router seals every request or refuses it, whatever route the request asks for', lockedCheap.status === 200 && lockedCheap.headers.get('x-orrery-sealed') === '1' && lockedCheap.headers.get('x-orrery-route') === 'privacy' && nameOf(lockedCheap.headers.get('x-orrery-provider')) === 'Vault Nine' && lockedNone.status === 503 && /verified enclave/.test(lockedNoneJ.error?.message ?? ''), `llama-3.3-70b:cheap with x-orrery-route: price → ${nameOf(lockedCheap.headers.get('x-orrery-provider'))}, sealed, route ${lockedCheap.headers.get('x-orrery-route')} · deepseek-v3 (no enclave lists it) → ${lockedNone.status}: ${lockedNoneJ.error?.message}`);

// Wire sealing: a request to a node without an enclave still travels encrypted to the node's own key, so a firewall
// or load balancer in front of the node sees ciphertext. An older router's plain request is still served.
const wireKeyOf = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/v1/wire`)).json()) as { key: string; sig: string; node: string };
const wireAsk = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v3', max_tokens: 32, messages: [{ role: 'user', content: "'; DROP TABLE users; -- ../../../../etc/shadow" }] }) });
const wireAskJ = (await wireAsk.json()) as { choices?: { message?: { content?: string } }[] };
const wireTrip = trips[trips.length - 1] as { wire?: boolean; sealed?: boolean; providerName?: string };
// A router holding a stale key (the node restarted with a new one) is told so, reads the key again and carries on.
const { newEnclaveKey } = await import('../src/seal.ts');
registry.entries.get(iron.pda.toBase58())!.wire = newEnclaveKey().publicKey;
const staleAsk = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': iron.pda.toBase58() }, body: JSON.stringify({ model: 'deepseek-v3', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
await staleAsk.json();
const healed = staleAsk.status === 200 && registry.entries.get(iron.pda.toBase58())?.wire?.toString('hex') === wireKeyOf.key;
check('a request to a node without an enclave travels encrypted to the node’s own key, signed by the node key on chain', wireKeyOf.key.length === 64 && wireKeyOf.node === iron.node.publicKey.toBase58() && registry.entries.get(iron.pda.toBase58())?.wire?.toString('hex') === wireKeyOf.key && wireAsk.status === 200 && wireAsk.headers.get('x-orrery-wire') === '1' && wireAsk.headers.get('x-orrery-sealed') === null && (wireAskJ.choices?.[0]?.message?.content ?? '').length > 5 && wireTrip.wire === true && wireTrip.sealed === false && healed, `deepseek-v3 → ${wireTrip.providerName} · x-orrery-wire ${wireAsk.headers.get('x-orrery-wire')} · wire key ${wireKeyOf.key.slice(0, 16)}… signed by the node key · a stale key is replaced and the request retried: ${healed}`);

// Task budgets: an agent gives a job one budget, and every request under that name draws from it.
const taskAsk = (first: boolean) => fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-task': 'rehearsal-job', ...(first ? { 'x-orrery-task-budget': '0.00003' } : {}) }, body: JSON.stringify({ model: 'llama-3.3-70b:cheap', max_tokens: 32, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const taskRuns: { status: number; left: string | null; spent: string | null; code?: string }[] = [];
for (let i = 0; i < 6; i++) {
  const r = await taskAsk(i === 0);
  const j = (await r.json()) as { error?: { code?: string } };
  taskRuns.push({ status: r.status, left: r.headers.get('x-orrery-task-left'), spent: r.headers.get('x-orrery-task-spent'), code: j.error?.code });
  if (r.status !== 200) break;
}
const taskList = (await (await fetch(`${ROUTER}/orrery/tasks`)).json()) as { tasks: { name: string; budget: string; spent: string; left: string; answers: number }[] };
const job = taskList.tasks.find((t) => t.name === 'rehearsal-job');
const spendByTask = (await (await fetch(`${ROUTER}/orrery/spend?since=24h&by=task`)).json()) as { rows: { key: string; answers: number; usd: string }[] };
const jobSpend = spendByTask.rows.find((x) => x.key === 'rehearsal-job');
const lastRun = taskRuns[taskRuns.length - 1];
check('a task budget covers every request under one name and stops the job before it is passed', taskRuns[0].status === 200 && lastRun.status === 402 && ['over_budget', 'task_budget_spent'].includes(lastRun.code ?? '') && !!job && Number(job.spent) <= 0.00003 && job.answers === taskRuns.length - 1 && jobSpend?.answers === job.answers && jobSpend.usd === job.spent && existsSync(join(process.env.ORRERY_HOME!, 'router', 'tasks.json')), job ? `budget $${job.budget} · ${job.answers} answers paid, $${job.spent} spent · request ${taskRuns.length} refused (${lastRun.code}) · left after each: ${taskRuns.filter((t) => t.left).map((t) => t.left).join(', ')}` : 'no task');
// The other refusal: the job's budget is lowered under what it already spent, so nothing at all is left.
const spentAsk = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-task': 'rehearsal-job', 'x-orrery-task-budget': '0.000001' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'One more.' }] }) });
const spentSaid = { status: spentAsk.status, code: ((await spentAsk.json()) as { error?: { code?: string } }).error?.code, left: spentAsk.headers.get('x-orrery-task-left'), spent: spentAsk.headers.get('x-orrery-task-spent') };
check('a request refused for a job’s budget says in headers what the job has spent and has left, so an agent need not read it out of a sentence', lastRun.status === 402 && !!job && lastRun.left !== null && lastRun.left === job.left && lastRun.spent === job.spent && spentSaid.status === 402 && spentSaid.code === 'task_budget_spent' && spentSaid.left === '0.000000' && spentSaid.spent === job.spent, `${lastRun.code}: x-orrery-task-spent ${lastRun.spent} · x-orrery-task-left ${lastRun.left}${job ? ` (the book says $${job.spent} spent, $${job.left} left)` : ''} · ${spentSaid.code}: spent ${spentSaid.spent} · left ${spentSaid.left}`);

// Who is asking stays on this machine: ids that clients attach in all three API shapes never reach a model server.
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const idAsks = await Promise.all([
  fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b:cheap', max_tokens: 16, user: 'alice@example.com', metadata: { account: 'acct_123' }, safety_identifier: 'sid_9', prompt_cache_key: 'alice-4', messages: [{ role: 'user', content: 'Say hello.' }] }) }),
  fetch(`${ROUTER}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, metadata: { user_id: 'user_3f9c_account_6b1e_session_0d5a' }, messages: [{ role: 'user', content: 'Say hello.' }] }) }),
  fetch(`${ROUTER}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_output_tokens: 16, user: 'u_42', input: 'Say hello.' }) }),
]);
for (const r of idAsks) await r.text();
const withheldSaid = idAsks.map((r) => r.headers.get('x-orrery-withheld'));
const sawIdentity = await Promise.all(upstreams.filter(([, , l]) => l !== 'halo').map(async ([port, , l]) => ({ l, fields: ((await (await fetch(`http://127.0.0.1:${port}/v1/seen-identity`)).json()) as { fields: string[] }).fields })));
check('ids a client attaches to say who is asking (user, metadata.user_id, safety_identifier, a cache key) never reach a model server',
  idAsks.every((r) => r.status === 200) && sawIdentity.every((s) => s.fields.length === 0)
  && withheldSaid[0] === 'user,metadata,safety_identifier,prompt_cache_key' && withheldSaid[1] === 'metadata' && withheldSaid[2] === 'user',
  `chat, messages and responses answered ${idAsks.map((r) => r.status).join(' ')} · model servers saw: ${sawIdentity.map((s) => `${s.l} ${s.fields.join('+') || 'none'}`).join(', ')} · each answer names what was withheld: ${withheldSaid.join(' | ')}`);

// orrery run: the CLI starts a client wired to this router as one job, and prints the job's bill when the client exits.
// The client is a stand-in named `claude` that sends one Anthropic request with exactly the environment it was given.
const stubDir = join(WORK, 'bin');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'claude'), `#!/usr/bin/env node
(async () => {
  const headers = { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '' };
  for (const l of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\\n')) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  const model = process.argv[process.argv.indexOf('--model') + 1];
  const r = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'Say hello.' }] }) });
  await r.json();
  console.log(JSON.stringify({ status: r.status, model, key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN ?? null, args: process.argv.slice(2) }));
  process.exit(r.status === 200 ? 0 : 1);
})();
`, { mode: 0o755 });
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const ran = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
  let out = '', err = '';
  const pr = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'run', 'claude', '--router', ROUTER, '--model', 'llama-3.3-70b', '--task', 'rehearsal-run', '--', '-p', 'hello'],
    { cwd: join(ROOT, 'node'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'sk-ant-not-passed-on', ANTHROPIC_AUTH_TOKEN: 'not-passed-on' } });
  pr.stdout!.on('data', (d) => (out += d));
  pr.stderr!.on('data', (d) => (err += d));
  const timer = setTimeout(() => pr.kill('SIGTERM'), 60_000);
  pr.on('exit', (code) => { clearTimeout(timer); done({ code, out, err }); });
});
let stubSaid: { status?: number; model?: string; key?: string; token?: string | null; args?: string[] } = {};
try { stubSaid = JSON.parse(ran.out.trim().split('\n').pop() ?? '{}'); } catch { /* the check below reports it */ }
const runTask = ((await (await fetch(`${ROUTER}/orrery/tasks`)).json()) as { tasks: { name: string; budget: string; spent: string; answers: number }[] }).tasks.find((t) => t.name === 'rehearsal-run');
const billLine = ran.err.split('\n').find((l) => l.includes('answer')) ?? '';
// The same for a tool that knows nothing of Orrery: it reads OPENAI_BASE_URL and OPENAI_API_KEY, and the key carries the job.
writeFileSync(join(stubDir, 'some-agent'), `#!/usr/bin/env node
(async () => {
  const r = await fetch(process.env.OPENAI_BASE_URL + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
  await r.json();
  console.log(JSON.stringify({ status: r.status, key: process.env.OPENAI_API_KEY }));
  process.exit(r.status === 200 ? 0 : 1);
})();
`, { mode: 0o755 });
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const anyRan = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
  let out = '', err = '';
  const pr = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'run', '--router', ROUTER, '--budget', '0.002', '--task', 'rehearsal-any', '--', 'some-agent'],
    { cwd: join(ROOT, 'node'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, OPENAI_API_KEY: 'sk-not-passed-on' } });
  pr.stdout!.on('data', (d) => (out += d));
  pr.stderr!.on('data', (d) => (err += d));
  const timer = setTimeout(() => pr.kill('SIGTERM'), 60_000);
  pr.on('exit', (code) => { clearTimeout(timer); done({ code, out, err }); });
});
let anySaid: { status?: number; key?: string } = {};
try { anySaid = JSON.parse(anyRan.out.trim().split('\n').pop() ?? '{}'); } catch { /* the check below reports it */ }
const anyTask = ((await (await fetch(`${ROUTER}/orrery/tasks`)).json()) as { tasks: { name: string; budget: string; spent: string; answers: number }[] }).tasks.find((t) => t.name === 'rehearsal-any');
check('orrery run starts a client on the router as one job with a budget (a dollar by default), hands it no key of yours, prints the bill when it exits, and does the same for any tool through the API key',
  ran.code === 0 && stubSaid.status === 200 && stubSaid.key === 'orrery' && stubSaid.token === null && (stubSaid.args ?? []).join(' ') === '--model llama-3.3-70b -p hello'
  && !!runTask && runTask.answers === 1 && Number(runTask.budget) === 1 && ran.err.includes('budget $1 (default') && ran.err.includes('orrery · rehearsal-run') && /1 answer · [\d,]+ tokens/.test(billLine) && billLine.includes(`$${runTask.spent} of $1.00 budget`)
  && anyRan.code === 0 && anySaid.status === 200 && anySaid.key === 'orrery/rehearsal-any/0.002' && !!anyTask && anyTask.answers === 1 && Number(anyTask.budget) === 0.002 && anyRan.err.includes('of $0.002 budget'),
  `exit ${ran.code} · ${billLine.trim()} · a tool that only takes a key: ${(anyRan.err.split('\n').find((l) => l.includes('answer')) ?? '').trim()}`);

// Where the time went: every answer says it in a standard header, and the router's record keeps the stages.
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const timed = await ask('llama-3.3-70b');
const timedTrip = router.trips[router.trips.length - 1];
const timedHeader = String((timed as { headers?: Headers }).headers?.get('server-timing') ?? '');
const timedStream = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'Say hi.' }] }) });
await timedStream.text();
const timedStreamHeader = String(timedStream.headers.get('server-timing') ?? '');
check('an answer says where its time went (Server-Timing): choosing the node, the channel, sealing, the wait for the node with the node’s own account of it, and signing the payment',
  /^route;dur=[\d.]+, channel;dur=[\d.]+, seal;dur=[\d.]+, node;dur=[\d.]+, node-open;dur=[\d.]+, node-check;dur=[\d.]+, node-upstream;dur=[\d.]+, sign;dur=[\d.]+$/.test(timedHeader)
  && /^route;dur=[\d.]+, channel;dur=[\d.]+, seal;dur=[\d.]+, node;dur=[\d.]+, node-open;dur=[\d.]+, node-check;dur=[\d.]+, node-upstream;dur=[\d.]+$/.test(timedStreamHeader)
  && (timedTrip.ms?.nodeOpen ?? -1) >= 0 && (timedTrip.ms?.nodeCheck ?? -1) >= 0 && (timedTrip.ms?.nodeUpstream ?? 0) > 0 && (timedTrip.ms?.nodeUpstream ?? 0) <= (timedTrip.ms?.node ?? 0)
  && !!timedTrip.ms && timedTrip.ms.node > 0 && timedTrip.ms.route + timedTrip.ms.seal + timedTrip.ms.sign < timedTrip.ms.node,
  timedHeader);

// A node's connection carries one answer after another: the router reads each answer to its end, so the next request
// rides the connection already open instead of paying for a new one.
const keptNode = nodes.find((n) => n.pda.toBase58() === timedTrip.provider)!;
let keptOpened = 0;
(keptNode as unknown as { server: { on(e: 'connection', f: () => void): void } }).server.on('connection', () => keptOpened++);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const keptRuns: { status: number }[] = [];
for (let i = 0; i < 5; i++) {
  keptRuns.push(await ask('llama-3.3-70b', { header: { 'x-orrery-provider': timedTrip.provider } }));
  await sleep(150);
}
check('five answers in a row from one node ride connections already open: the router reads each answer to its end instead of dropping the stream',
  keptRuns.every((x) => x.status === 200) && keptOpened <= 2, `${keptRuns.length} answers, ${keptOpened} new connection${keptOpened === 1 ? '' : 's'} to the node`);

// Through a proxy: the router reaches nodes only by it, the proxy carries requests it cannot read, and when the proxy
// is gone the request fails instead of going out directly.
const proxied: { url: string; body: string; answer?: string; headers?: Record<string, unknown> }[] = [];
let slowVouchers = false;
// What the platform in front of Ironbridge could do to its /v1/wire answer: drop the signature on its 'inside' flag,
// drop the flag too, or answer that there is no wire key at all.
let wireTamper: null | 'unsigned' | 'strip' | 'gone' = null;
let wireTamperPort: number = providerSpecs[1].port;
const recorder = createHttpServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const rec: { url: string; body: string; answer?: string; headers?: Record<string, unknown> } = { url: req.url ?? '', body, headers: { ...req.headers } };
    proxied.push(rec);
    const u = new URL(req.url ?? '');
    const tampered = !!wireTamper && u.pathname === '/v1/wire' && u.port === String(wireTamperPort);
    if (tampered && wireTamper === 'gone') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }));
      return;
    }
    const out = httpRequest({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: req.method, headers: req.headers }, (r) => {
      if (tampered) {
        let raw = '';
        r.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        r.on('end', () => {
          const j = JSON.parse(raw) as Record<string, unknown>;
          delete j.insideSig;
          if (wireTamper === 'strip') delete j.inside;
          const b = JSON.stringify(j);
          rec.answer = b;
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(b)) }).end(b);
        });
        return;
      }
      res.writeHead(r.statusCode ?? 502, r.headers);
      // What came back, as the proxy saw it.
      rec.answer = '';
      r.on('data', (c: Buffer) => (rec.answer += c.toString('latin1')));
      r.pipe(res);
    });
    out.on('error', () => res.writeHead(502).end());
    // A voucher on its way to the node can be held back here, to look at the moment before it lands.
    setTimeout(() => out.end(body), slowVouchers && (req.url ?? '').includes('/orrery/voucher') ? 700 : 0);
  });
});
await new Promise<void>((done) => recorder.listen(0, '127.0.0.1', () => done()));
setNodeProxy(parseProxy(`127.0.0.1:${(recorder.address() as { port: number }).port}`));
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const tripsBeforeProxy = router.trips.length;
const throughProxy = await ask('llama-3.3-70b');
const tripsAfterThrough = router.trips.length;
const proxyTrip = router.trips[router.trips.length - 1];
const proxyCarried = proxied.filter((x) => x.url.includes('/v1/chat/completions'));
const statusWithProxy = (await (await fetch(`${ROUTER}/orrery/status`)).json()) as { proxy: string | null };
const proxiedRpc = rpcConnection(RPC);
const rpcBefore = proxied.length;
const proxiedBalance = await proxiedRpc.getBalance(user.publicKey);
const proxiedTransfer = await sendOne(proxiedRpc, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 1_000 })), [admin]).catch((e) => `failed: ${(e as Error).message}`);
const proxiedAfter = await proxiedRpc.getBalance(user.publicKey);
const rpcCalls = proxied.slice(rpcBefore).filter((x) => x.url.startsWith(RPC)).map((x) => (JSON.parse(x.body) as { method: string }).method);
const proxyRead = proxied.some((x) => x.body.includes('payment channel') || x.body.includes('In one sentence'));
// What the proxy sees of a request is its length. Two prompts of very different lengths, the same model and node:
// the bodies it carried must be the same length (the size class), not the prompts' lengths.
const sized = async (content: string) => {
  const before = proxied.length;
  const r = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content }] }) });
  await r.text();
  return proxied.slice(before).filter((x) => x.url.includes('/v1/chat/completions')).map((x) => x.body.length);
};
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const shortSent = await sized('Say hi.');
const longSent = await sized(`Summarize this in one line: ${'the quick brown fox jumps over the lazy dog '.repeat(14)}`);
// The answer to the long prompt, as the proxy carried it: its sealed frames, by length.
const answered = proxied.filter((x) => x.url.includes('/v1/chat/completions')).at(-1)?.answer ?? '';
const frameLengths = [...answered.matchAll(/^data: ([A-Za-z0-9+/=]+)$/gm)].map((m) => Buffer.from(m[1], 'base64').length);
check('the frames of a sealed answer are one length, so a proxy cannot read token lengths off them', frameLengths.length >= 4 && new Set(frameLengths).size === 1, `${frameLengths.length} sealed frames, ${new Set(frameLengths).size} distinct length${new Set(frameLengths).size === 1 ? '' : 's'}: ${[...new Set(frameLengths)].slice(0, 6).join(', ')} bytes`);
// Which channel a request pays from is between the router and the node process: what the proxy carried to the node
// names no channel, in headers, in the request or in the voucher handed over after it.
const ibChannel = channels.get(nodes[1].pda.toBase58())?.channel ?? '';
const toIb = proxied.filter((x) => x.url.startsWith(`http://127.0.0.1:${providerSpecs[1].port}/`));
const askIb = toIb.filter((x) => x.url.includes('/v1/chat/completions')), payIb = toIb.filter((x) => x.url.includes('/orrery/voucher'));
const named = toIb.filter((x) => JSON.stringify(x.headers ?? {}).includes(ibChannel) || x.body.includes(ibChannel));
// A node that has not said it reads payment inside (an older node) still gets it as headers, and still answers.
const ibEntry = registry.entries.get(nodes[1].pda.toBase58()) as unknown as { wireInside?: boolean };
const hadInside = ibEntry.wireInside;
ibEntry.wireInside = false;
const beforeOld = proxied.length;
// What the node writes to its log for each answer, kept to compare below.
const ibLogged = (lines: string[]) => { const was = iron.log; iron.log = (l) => { lines.push(l); was(l); }; return () => { iron.log = was; }; };
const oldLines: string[] = [];
const stopOld = ibLogged(oldLines);
const asOld = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) });
await asOld.text();
await sleep(200);
stopOld();
ibEntry.wireInside = hadInside;
const oldAsk = proxied.slice(beforeOld).find((x) => x.url.includes('/v1/chat/completions'));
// A prompt under the router's floor for Ironbridge's 131,072 tokens but over what its model server counts: the server
// refuses it. The node says why in its own log, without the server's text, and the router hears context_length_exceeded.
{
  const lines: string[] = [];
  const stop = ibLogged(lines);
  const big = `${'Payment channels settle on Solana. '.repeat(17_200)}Done?`;
  const rr = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': iron.pda.toBase58() }, body: JSON.stringify({ model: 'deepseek-v3', max_tokens: 64, messages: [{ role: 'user', content: big }] }) });
  const rrj = await rr.json().catch(() => ({})) as { error?: { message?: string } };
  await sleep(100);
  stop();
  for (const o of router.stats.all().values()) o.cooldownUntil = 0;
  const said = lines.find((l) => l.includes('model server')) ?? '';
  check('a node says in its own log why its model server turned a request away, without the server’s words, and the router hears it as context_length_exceeded', said === 'the model server refused a deepseek-v3 request as longer than it serves (400); provider.json lists 131,072 tokens of context for it: set "context" to what the server serves (orrery provider check compares them)' && /provider answered 400 \(context_length_exceeded\)/.test(rrj.error?.message ?? ''),
    `${said.slice(0, 110) || 'nothing in the node log'} · router: ${(rrj.error?.message ?? '').replace(/^.*?: /, '').slice(0, 90)}`);
  // The node keeps that refusal, and orrery provider status says it, for an operator who is not reading the log.
  const refusedStatus = await cliOut(['status']);
  const refusedLine = refusedStatus.split('\n').find((l) => l.trim().startsWith('model server refused')) ?? '';
  // And provider check, the command an operator runs most, says the same.
  const refusedCheck = await cliOut(['check']);
  const refusedCheckLine = refusedCheck.split('\n').find((l) => /^\S refusals /.test(l)) ?? '';
  check('orrery provider check says what the model server refused in the last 24 hours', /^· refusals +the model server refused \d+ in the last 24 h: \d+ longer than it serves/.test(refusedCheckLine), refusedCheckLine.slice(0, 150) || 'no refusals line in provider check');
  check('orrery provider status counts what the model server refused in the last 24 hours, by kind', /^ {2}model server refused {2}\d+ in the last 24 h: (\d+ longer than it serves)$/.test(refusedLine) && Number(/(\d+) longer/.exec(refusedLine)?.[1]) >= 1, refusedLine.trim() || 'no such line in provider status');
}
// A router that lost its records finds its channel on chain and asks the node where it stands. To a node that reads
// payment inside the seal, that question is sealed as well: nothing reaching the node's front names the channel.
const beforeRecover = proxied.length;
const rebornSealed = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels-sealed-recover.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
(rebornSealed as unknown as { wireOf?: (p: string) => { key: Buffer; inside: boolean } | null }).wireOf = (p) => { const e = registry.entries.get(p); return e?.wire ? { key: e.wire, inside: !!e.wireInside } : null; };
const pickedSealed = await rebornSealed.ensure(nodes[1].pda.toBase58(), 1n).then((c) => c.channel, (e: Error) => `refused: ${e.message}`);
const askedAbout = proxied.slice(beforeRecover).filter((x) => x.url.includes('/orrery/channel'));
const askedNaming = askedAbout.filter((x) => x.url.includes(ibChannel) || x.body.includes(ibChannel) || (x.answer ?? '').includes(ibChannel));
check('a router that lost its records asks the node about its channel sealed, so neither the question nor the answer shows the node’s front which channel it picks back up', pickedSealed === ibChannel && askedAbout.length >= 1 && askedNaming.length === 0, `picked back up: ${pickedSealed === ibChannel ? 'the same channel' : pickedSealed} · ${askedAbout.length} question${askedAbout.length === 1 ? '' : 's'} about it through the proxy, ${askedNaming.length} naming it`);
// An older node, one that has not said it reads payment inside, is still asked the old way and still answers.
const beforeOldRecover = proxied.length;
const rebornOld = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels-old-recover.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
(rebornOld as unknown as { wireOf?: (p: string) => { key: Buffer; inside: boolean } | null }).wireOf = (p) => { const e = registry.entries.get(p); return e?.wire ? { key: e.wire, inside: false } : null; };
const pickedOld = await rebornOld.ensure(nodes[1].pda.toBase58(), 1n).then((c) => c.channel, (e: Error) => `refused: ${e.message}`);
const askedOld = proxied.slice(beforeOldRecover).filter((x) => x.url.includes('/orrery/channel'));
check('an older node is still asked about a lost channel the old way, and the same channel comes back', pickedOld === ibChannel && askedOld.length >= 1 && askedOld.every((x) => x.url.includes(`address=${ibChannel}`)), `picked back up: ${pickedOld === ibChannel ? 'the same channel' : pickedOld} · ${askedOld.length} question${askedOld.length === 1 ? '' : 's'}, by ${askedOld.map((x) => new URL(x.url).search ? 'GET with the channel in the query' : 'POST').join(', ')}`);
const recoverView = (x: { url: string; body: string; answer?: string } | undefined) => x && ({ method: x.body ? 'POST' : 'GET', path: new URL(x.url).pathname + new URL(x.url).search, bodyBytes: x.body.length, bodyStart: x.body.slice(0, 96), answerBytes: (x.answer ?? '').length, answerStart: (x.answer ?? '').slice(0, 160) });
writeFileSync(join(WORK, 'recover.json'), JSON.stringify({ channel: ibChannel, node: 'Ironbridge Compute', sealed: recoverView(askedAbout.at(-1)), old: recoverView(askedOld.at(-1)) }, null, 1));
// A node's own tally can sit below the latest voucher: the router signed for a little more than the node counted.
// The node is then owed nothing beyond the voucher, and a router that lost its records carries on from it.
const ibLedger = (iron as unknown as { ledger: Map<string, { owed: bigint; best?: { cumulative: bigint } }> }).ledger.get(ibChannel);
const ibOwed = ibLedger?.owed ?? 0n;
if (ibLedger?.best) ibLedger.owed = ibLedger.best.cumulative - 13n;
const rebornUnder = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels-under-recover.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
const pickedUnder = await (rebornUnder as unknown as { recover: (p: string) => Promise<{ channel: string; cumulative: bigint } | null> }).recover(nodes[1].pda.toBase58()).then((c) => c?.channel ?? 'nothing', (e: Error) => `refused: ${e.message}`);
if (ibLedger) ibLedger.owed = ibOwed;
check('a router that lost its records carries on from its voucher when the node counts a little less than it signed for, instead of setting the channel aside', !!ibLedger?.best && pickedUnder === ibChannel, `node’s tally 13 units under the voucher · picked back up: ${pickedUnder === ibChannel ? 'the same channel' : pickedUnder}`);
// The flag that says a node reads payment inside counts only with the node key's signature on it: a router meeting
// the node for the first time does not take the platform's word for it.
wireTamper = 'unsigned';
const firstSight = new Registry(conn, { allowDev: true, measurements: [] });
await firstSight.refresh();
wireTamper = null;
const firstIb = firstSight.entries.get(nodes[1].pda.toBase58());
check('a node’s “I read payment inside” counts only with its node key’s signature on it', !!firstIb?.wire && firstIb.wireInside === false, `unsigned flag: ${firstIb?.wire ? (firstIb.wireInside ? 'believed' : 'not believed, payment stays in headers for a node met this way') : 'no wire key read'}`);
// A router that has seen the signed flag keeps to it. A front that then strips the flag gets no headers back.
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
wireTamper = 'strip';
await registry.refreshWire(nodes[1].pda.toBase58());
const beforeStrip = proxied.length;
const afterStrip = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) });
await afterStrip.text();
const stripAsk = proxied.slice(beforeStrip).find((x) => x.url.includes('/v1/chat/completions'));
check('once a router has seen a node’s signed flag, a front that strips it does not get the payment headers back', afterStrip.status === 200 && !!stripAsk && stripAsk.headers?.['x-orrery-channel'] === undefined && !stripAsk.body.includes(ibChannel), `flag stripped from /v1/wire: ${afterStrip.status}, channel header ${stripAsk?.headers?.['x-orrery-channel'] === undefined ? 'not sent' : 'sent'}`);
// Nor does a front that hides the wire key: the router does not send that node the prompt in the clear.
wireTamper = 'gone';
await registry.refreshWire(nodes[1].pda.toBase58());
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const beforeGone = proxied.length;
const afterGone = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58(), 'x-orrery-patience': '0' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi in a plain sentence.' }] }) });
await afterGone.text();
const goneClear = proxied.slice(beforeGone).filter((x) => x.url.startsWith(`http://127.0.0.1:${providerSpecs[1].port}/v1/chat`) && x.body.includes('Say hi in a plain sentence'));
// The same goes for a router that lost its records: it does not ask that node about its channel in the clear.
const beforeGoneRecover = proxied.length;
const rebornGone = new Channels(conn, user, session, usdc, join(WORK, 'home/router/channels-gone-recover.json'), { deposit: USD, topUpBelow: USD / 5n, dailyCap: 5n * USD });
(rebornGone as unknown as { wireOf: unknown }).wireOf = (channels as unknown as { wireOf: unknown }).wireOf;
const goneRecovered = await (rebornGone as unknown as { recover: (p: string) => Promise<{ channel: string } | null> }).recover(nodes[1].pda.toBase58()).then((c) => c?.channel ?? 'nothing', (e: Error) => `refused: ${e.message}`);
const goneAsked = proxied.slice(beforeGoneRecover).filter((x) => x.url.includes('/orrery/channel'));
const goneNamed = goneAsked.filter((x) => x.url.includes(ibChannel) || x.body.includes(ibChannel) || (x.answer ?? '').includes(ibChannel));
check('nor does a router that lost its records ask that node about its channel in the clear, and it opens no second one', goneNamed.length === 0 && goneRecovered !== 'nothing' && goneRecovered !== ibChannel, `${goneAsked.length} question${goneAsked.length === 1 ? '' : 's'} about the channel, ${goneNamed.length} naming it · ${goneRecovered.startsWith('refused') ? 'refused to guess, no second channel' : goneRecovered === ibChannel ? 'picked it back up' : goneRecovered}`);
type Sealing = { providers: { address: string; sealing?: string }[] };
const sealingOf = async () => ((await (await fetch(`${ROUTER}/orrery/status`)).json()) as Sealing).providers.find((p) => p.address === nodes[1].pda.toBase58())?.sealing;
const sealingHidden = await sealingOf();
wireTamper = null;
await registry.refreshWire(nodes[1].pda.toBase58());
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const backIb = registry.entries.get(nodes[1].pda.toBase58());
const sealingBack = await sealingOf();
check('the router’s status says how each node gets the request and the payment, including a node it is holding back from', sealingHidden === 'withheld' && sealingBack === 'inside', `Ironbridge with its wire key hidden: ${sealingHidden ?? 'not said'} · once it shows again: ${sealingBack ?? 'not said'}`);
check('a front that hides the wire key of a node that showed one does not get the prompt in the clear', goneClear.length === 0 && !!backIb?.wire && backIb.wireInside === true, `wire key hidden: ${goneClear.length} request${goneClear.length === 1 ? '' : 's'} to it in the clear (answer ${afterGone.status}) · once it shows again: ${backIb?.wire ? 'wire key read' : 'no wire key'}, inside ${backIb?.wireInside ? 'yes' : 'no'}`);
// A node owed for an answer it holds no voucher for says so with a 402 and the unpaid records, which the router pays
// before it goes on. To a router that pays inside the seal those details (totals, records) are sealed as well.
const ibAddr = nodes[1].pda.toBase58();
type Settle = (p: string, rec: unknown) => unknown;
const chs = channels as unknown as { settle: Settle };
const settleReal: Settle = chs.settle.bind(channels);
let skipSettle = true;
chs.settle = (p, rec) => {
  if (skipSettle && p === ibAddr) {
    skipSettle = false;
    throw new Error('the router stopped before signing');
  }
  return settleReal(p, rec);
};
const ibAsk = (content: string) => fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': ibAddr, 'x-orrery-patience': '0' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content }] }) }).then(async (r) => { await r.text(); return r.status; });
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
await ibAsk('Say hi.');
// What the node's own book says at each step: what it is owed, and the signed total it holds.
const owedHeld = () => { const l = (iron as unknown as { ledger: Map<string, { owed: bigint; best?: { cumulative: bigint } }> }).ledger.get(ibChannel); return { owed: l?.owed ?? 0n, held: l?.best?.cumulative ?? 0n }; };
const shorted = owedHeld();
chs.settle = settleReal;
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const beforeOwed = proxied.length;
const afterUnpaid = await ibAsk('Say hi again.');
// The router paid the answer it had skipped before the node served again; the voucher for the new answer follows it.
const paidUp = owedHeld();
for (let i = 0; i < 30 && owedHeld().held < owedHeld().owed; i++) await sleep(100);
const madeWhole = owedHeld();
writeFileSync(join(WORK, 'unpaid-gate.json'), JSON.stringify({ node: 'Ironbridge Compute', model: 'llama-3.3-70b', afterTheUnsignedAnswer: { owed: shorted.owed.toString(), held: shorted.held.toString() }, heldWhenServedAgain: paidUp.held.toString(), afterTheNextRequest: { owed: madeWhole.owed.toString(), held: madeWhole.held.toString(), status: afterUnpaid } }, null, 1));
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const refusals = proxied.slice(beforeOwed).filter((x) => x.url.includes('/v1/chat/completions') && /payment_required/.test(x.answer ?? ''));
const totalsInClear = refusals.filter((x) => /"(owed|paid|unpaid|deposit)"/.test(x.answer ?? ''));
check('a node’s 402 for an unpaid answer is sealed to a router that pays inside the seal, and the router still pays it and goes on', !skipSettle && refusals.length >= 1 && totalsInClear.length === 0 && afterUnpaid === 200 && shorted.owed > shorted.held && paidUp.held >= shorted.owed && madeWhole.held >= madeWhole.owed, `${refusals.length} payment_required answer${refusals.length === 1 ? '' : 's'} through the proxy, ${totalsInClear.length} with totals in the clear${totalsInClear[0] ? `: ${(totalsInClear[0].answer ?? '').slice(0, 90)}` : ''} · the request after it: ${afterUnpaid} · the node’s book: owed ${shorted.owed} and held a signature for ${shorted.held} after the unsigned answer, held ${paidUp.held} when it served again, owed ${madeWhole.owed} and holds ${madeWhole.held} once that answer was signed for`);
// Each answer tells the client how its payment traveled: inside the seal to a node that reads it there, in headers
// to one that does not.
const insideLines: string[] = [];
const stopInside = ibLogged(insideLines);
const insideAnswer = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) });
await insideAnswer.text();
await sleep(200);
stopInside();
// A node's log goes to whoever hosts it (a platform's log service, the host of an enclave): the party the seal keeps
// the channel from. The line for an answer paid inside the seal names neither the channel nor its running total.
const servedInside = insideLines.find((l) => l.startsWith('served '));
const servedOld = oldLines.find((l) => l.startsWith('served '));
check('a node’s log keeps out what was paid inside the seal: no channel and no running total on that answer’s line, while an answer paid in headers still names its channel', !!servedInside && !!ibChannel && !servedInside.includes(ibChannel.slice(0, 6)) && !/owed/.test(servedInside) && !!servedOld && servedOld.includes(ibChannel.slice(0, 6)), `paid inside: ${servedInside?.replace(ibChannel.slice(0, 6), '<channel>') ?? 'no line'} · in headers: ${servedOld?.replace(ibChannel.slice(0, 6), '<channel>') ?? 'no line'}`);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
// Every answer names the node that gave it, from its price list, streamed or not.
const streamedIb = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'Say hi.' }] }) });
await streamedIb.text();
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
check('every answer names the node that gave it, streamed or not', insideAnswer.headers.get('x-orrery-provider-name') === 'Ironbridge Compute' && streamedIb.status === 200 && streamedIb.headers.get('x-orrery-provider-name') === 'Ironbridge Compute', `as JSON: ${insideAnswer.headers.get('x-orrery-provider-name') ?? 'not named'} · streamed: ${streamedIb.headers.get('x-orrery-provider-name') ?? 'not named'}`);
check('every answer says how its payment traveled: inside the seal, or in headers to an older node', insideAnswer.status === 200 && insideAnswer.headers.get('x-orrery-payment') === 'inside' && asOld.headers.get('x-orrery-payment') === 'headers', `to Ironbridge: ${insideAnswer.headers.get('x-orrery-payment') ?? 'not said'} · as an older node: ${asOld.headers.get('x-orrery-payment') ?? 'not said'}`);
// The operator's side of the same thing: how many answers this node was paid for inside the seal, and how many named
// their channel in headers its host could read (routers before 0.1.16, or this rig posing as one above).
const ibEarned = (await (await fetch(`http://127.0.0.1:${providerSpecs[1].port}/orrery/earnings?since=24h`, { headers: { 'x-orrery-console-key': ibKey } })).json()) as { total: { answers: number }; paidInside?: { answers: number; inside: number }; onChain?: { payouts: number; settled: string } | null };
const ibListing = decodeProvider((await conn.getAccountInfo(nodes[1].pda))!.data);
check('a node tells its operator what has already landed on chain: payouts to its wallet and the total settled, from its listing', !!ibEarned.onChain && ibEarned.onChain.payouts === Number(ibListing.redeems) && ibEarned.onChain.payouts >= 1 && ibEarned.onChain.settled === usd(ibListing.settled), `Ironbridge: ${ibEarned.onChain ? `${ibEarned.onChain.payouts} payout${ibEarned.onChain.payouts === 1 ? '' : 's'}, $${ibEarned.onChain.settled} settled` : 'not said'} · listing on chain: ${String(ibListing.redeems)} redeems, $${usd(ibListing.settled)}`);
check('a node tells its operator how many answers were paid inside the seal and how many named their channel in headers', !!ibEarned.paidInside && ibEarned.paidInside.answers === ibEarned.total.answers && ibEarned.paidInside.inside >= 2 && ibEarned.paidInside.inside < ibEarned.paidInside.answers, `Ironbridge, last 24h: ${ibEarned.paidInside ? `${ibEarned.paidInside.inside} of ${ibEarned.paidInside.answers} answers paid inside the seal` : 'not said'}`);
// A node that put 'payment inside' in its price list, whose hash is on chain, is kept to from a router's first request:
// a front that strips the flag, or hides the wire key, before this router ever reached the node gets nothing more.
wireTamperPort = providerSpecs[3].port;
wireTamper = 'strip';
const listedSight = new Registry(conn, { allowDev: true, measurements: [] });
await listedSight.refresh();
const haloStripped = listedSight.entries.get(nodes[3].pda.toBase58());
const haloStrippedInside = haloStripped?.wireInside === true && !!haloStripped.wire;
wireTamper = 'gone';
await listedSight.refreshWire(nodes[3].pda.toBase58());
const haloGone = { wire: !!listedSight.entries.get(nodes[3].pda.toBase58())?.wire, pinned: listedSight.pinned(nodes[3].pda.toBase58()) };
wireTamper = null;
wireTamperPort = providerSpecs[1].port;
check('a node that lists payment inside in its price list on chain is kept to from the first request: stripping the flag or hiding the key gets its front nothing more', haloStrippedInside && !haloGone.wire && haloGone.pinned, `Halo, met for the first time behind a front that strips the flag: ${haloStrippedInside ? 'payment inside' : 'payment in headers'} · with its key hidden: ${haloGone.pinned && !haloGone.wire ? 'nothing sent in the clear' : 'would go in the clear'}`);
// A node key with no SOL cannot pay a redeem's fee. The node says so, with the address to top up, instead of a bare
// chain error: to its operator it would otherwise look like the payments stopped.
const ironLines: string[] = [];
const ironLogBefore = iron.log;
iron.log = (l) => { ironLines.push(l); ironLogBefore(l); };
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
await (await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) })).text();
await sleep(600);
const ironSol = await conn.getBalance(iron.node.publicKey);
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: iron.node.publicKey, toPubkey: admin.publicKey, lamports: ironSol - 5_000 })), [iron.node]);
const brokeRedeemed = await iron.redeemDue(1n).catch(() => []);
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: iron.node.publicKey, lamports: ironSol })), [admin]);
iron.log = ironLogBefore;
const feeLine = ironLines.find((l) => /redeem failed/.test(l));
check('a node whose key cannot pay redeem fees says so, with the address to send SOL to, and that what was signed is safe', brokeRedeemed.length === 0 && !!feeLine && feeLine.includes(iron.node.publicKey.toBase58()) && /send a little SOL/.test(feeLine) && /safe/.test(feeLine), feeLine ? feeLine.replace(iron.node.publicKey.toBase58(), '<node key>').slice(0, 220) : 'no redeem was attempted');
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
// Before it runs out: a node whose key is down to its last fees says so once, after a payout that still went
// through, with about how many are left. A second payout under the line does not say it again.
const lowLines: string[] = [];
iron.log = (l) => { lowLines.push(l); ironLogBefore(l); };
const ironFull = await conn.getBalance(iron.node.publicKey);
const lowKeep = 1_000_000;
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: iron.node.publicKey, toPubkey: admin.publicKey, lamports: ironFull - lowKeep - 5_000 })), [iron.node]);
const askIron = async () => { await (await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) })).text(); await sleep(600); for (const o of router.stats.all().values()) o.cooldownUntil = 0; };
await askIron();
const lowRedeemed = await iron.redeemDue(1n);
await askIron();
const lowAgain = await iron.redeemDue(1n);
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: iron.node.publicKey, lamports: ironFull - lowKeep })), [admin]);
iron.log = ironLogBefore;
const lowSaid = lowLines.filter((l) => /running low/.test(l));
check('a node whose key is running low on SOL for redeem fees says so once, before it runs out, with about how many payouts are left', lowRedeemed.length >= 1 && lowAgain.length >= 1 && lowSaid.length === 1 && lowSaid[0].includes(iron.node.publicKey.toBase58()) && /about \d+ more payouts/.test(lowSaid[0]), `${lowRedeemed.length} + ${lowAgain.length} payouts at ${(lowKeep / 1e9).toFixed(4)} SOL · ${lowSaid.length} heads-up line${lowSaid.length === 1 ? '' : 's'}${lowSaid[0] ? `: ${lowSaid[0].replace(iron.node.publicKey.toBase58(), '<node key>').slice(0, 200)}` : ''}`);
// What the node's front saw, kept for the media folder: one request and its voucher hand-over each way.
const frontOf = (x: { url: string; body: string; headers?: Record<string, unknown> } | undefined) => x && ({ path: new URL(x.url).pathname, headers: Object.fromEntries(Object.entries(x.headers ?? {}).filter(([k]) => !['host', 'connection', 'accept', 'accept-language', 'sec-fetch-mode', 'accept-encoding', 'user-agent'].includes(k))), bodyBytes: x.body.length, bodyStart: x.body.slice(0, 96) });
await sleep(400);
const oldPay = proxied.slice(beforeOld).find((x) => x.url === `http://127.0.0.1:${providerSpecs[1].port}/orrery/voucher` && !x.body.startsWith('{"wire"'));
writeFileSync(join(WORK, 'front.json'), JSON.stringify({ channel: ibChannel, node: 'Ironbridge Compute', inside: { ask: frontOf(askIb.at(-1)), pay: frontOf(payIb.filter((x) => x.body.startsWith('{"wire"')).at(-1)) }, headers: { ask: frontOf(oldAsk), pay: frontOf(oldPay) } }, null, 1));
// The node's answer to a sealed voucher hand-over is sealed too. A running total in the clear would let its front
// chain one wallet's answers together (each total is the one before plus a price) and match them to redemptions on chain.
const sealedPays = payIb.filter((x) => x.body.startsWith('{"wire"'));
const totalsShown = sealedPays.filter((x) => /"(paid|owed)"/.test(x.answer ?? ''));
check('a node answers a sealed voucher hand-over sealed, so its front sees no running total of what the channel has paid', sealedPays.length >= 1 && sealedPays.every((x) => (x.answer ?? '').length > 0) && totalsShown.length === 0, `${sealedPays.length} sealed hand-overs to Ironbridge, ${totalsShown.length} answered with the total in the clear${totalsShown[0] ? `: ${(totalsShown[0].answer ?? '').slice(0, 60)}` : ''}`);
check('to a node that reads payment inside the seal, the proxy and the node’s own front see no channel; an older node still gets it as headers', !!ibChannel && askIb.length >= 2 && payIb.length >= 1 && named.length === 0 && asOld.status === 200 && oldAsk?.headers?.['x-orrery-channel'] === ibChannel, `${askIb.length} requests and ${payIb.length} voucher hand-overs to Ironbridge through the proxy, ${named.length} naming the channel · as an older node: ${asOld.status}, channel header ${oldAsk?.headers?.['x-orrery-channel'] === ibChannel ? 'sent' : 'missing'}`);
check('a request is the same length on the wire whatever the prompt’s length within a size class, so a proxy learns the class and not the prompt’s length', shortSent.length === 1 && longSent.length === 1 && shortSent[0] === longSent[0], `bodies the proxy carried: ${shortSent.join(',')} bytes for 'Say hi.', ${longSent.join(',')} bytes for a prompt of ${28 + 44 * 14} characters`);
// The far side of the proxy: the router asks a node what address it sees, shows it on its status, and stops sending
// when what the node saw is this computer's own public address. Loopback is never public, so the rig says it counts.
type FarSide = { checkProxy?: (own?: string[], counts?: (a: string) => boolean) => Promise<{ line: string; givenAway: string | null } | null> };
const farSide = router as unknown as FarSide;
const farSaid = (await farSide.checkProxy?.()) ?? null;
const farStatus = (await (await fetch(`${ROUTER}/orrery/status`)).json()) as { proxySeen?: { node: string | null; address: string | null; givenAway: string | null } | null };
const farLeak = (await farSide.checkProxy?.(['127.0.0.1'], () => true)) ?? null;
const { handle: mcpHandle } = await import('../src/mcp.ts');
const mcpStatusText = async () => ((await mcpHandle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }, ROUTER, fetch as never, '0')) as { result: { content: { text: string }[] } }).result.content[0].text;
const mcpLeak = await mcpStatusText();
const tripsBeforeLeak = router.trips.length;
const leakAsk = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const leakSaid = ((await leakAsk.json()) as { error?: { code?: string } }).error?.code;
const leakPaid = router.trips.length - tripsBeforeLeak;
await farSide.checkProxy?.();
const mcpBack = await mcpStatusText();
const afterLeak = await ask('llama-3.3-70b');
check('behind a proxy the router asks a node what address it sees and shows it; when the node saw this computer’s own address the router stops sending, and starts again once it does not', !!farSaid && farSaid.givenAway === null && /sees 127\.0\.0\.1/.test(farSaid.line) && farStatus.proxySeen?.address === '127.0.0.1' && !!farStatus.proxySeen?.node && farLeak?.givenAway === '127.0.0.1' && leakAsk.status === 503 && leakSaid === 'proxy_gives_address_away' && leakPaid === 0 && afterLeak.status === 200, farSaid ? `${farSaid.line} · told the node saw its own address: ${leakAsk.status} ${leakSaid}, ${leakPaid} paid · asked again: ${afterLeak.status}` : 'the router has no far-side check');
const proxyLine = (t: string) => t.split('\n').find((l) => l.startsWith('leaving this computer:')) ?? 'no such line';
check('an agent asking the MCP status tool is told how its requests leave this computer: the proxy, what a node sees, and when the router has stopped', /through the proxy at 127\.0\.0\.1:\d+; \S.* sees 127\.0\.0\.1$/.test(proxyLine(mcpBack)) && /this computer’s own address/.test(proxyLine(mcpLeak)), `${proxyLine(mcpBack)} · while a node saw this computer: ${proxyLine(mcpLeak)}`);
// A node that restarts is away for a second or two. A request that arrives in that gap, and has no other node to go
// to, waits a moment and goes round again; before, it failed at once and the node was then refused for 15 seconds more.
setNodeProxy(null);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
const restarting = nodes[1] as unknown as { server: { closeAllConnections(): void } | null; close(): Promise<void>; listen(): Promise<unknown> };
restarting.server?.closeAllConnections();
await restarting.close();
setTimeout(() => void restarting.listen(), 1_200);
const tripsBeforeGap = router.trips.length;
const gapAt = Date.now();
const acrossGap = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const acrossBody = await acrossGap.text();
const gapMs = Date.now() - gapAt;
await sleep(1_300);
const afterGap = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58() }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
await afterGap.text();
check('a node that is away for a second costs the caller a short wait, not an error, and is not refused afterwards', acrossGap.status === 200 && gapMs >= 1_000 && gapMs < 9_000 && afterGap.status === 200 && router.trips.length === tripsBeforeGap + 2, `the only node asked for was away for 1.2 s: ${acrossGap.status} after ${gapMs} ms${acrossGap.status === 200 ? '' : ` (${acrossBody.slice(0, 110)})`} · the next request: ${afterGap.status}`);
// The same gap, but the agent says how long it will wait: 0 fails at once (it has somewhere else to go), and a value
// that is not a number of seconds is refused before anything is sent.
await restarting.close();
setTimeout(() => void restarting.listen(), 1_200);
const quickAt = Date.now();
const quick = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-provider': nodes[1].pda.toBase58(), 'x-orrery-patience': '0' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
await quick.text();
const quickMs = Date.now() - quickAt;
const silly = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-orrery-patience': 'forever' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hello.' }] }) });
const sillySaid = ((await silly.json()) as { error?: { code?: string; message?: string } }).error;
await sleep(1_400);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
check('an agent sets its own patience per request: x-orrery-patience: 0 fails at once, and a value that is not seconds is refused', quick.status === 502 && quickMs < 800 && silly.status === 400 && sillySaid?.code === 'bad_request' && /x-orrery-patience/.test(sillySaid?.message ?? ''), `patience 0 with the node away: ${quick.status} after ${quickMs} ms · 'forever': ${silly.status} ${sillySaid?.code ?? ''}`);
setNodeProxy(parseProxy(`127.0.0.1:${(recorder.address() as { port: number }).port}`));
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
// Stopping cleanly: right after an answer the voucher for it is still on its way. A router told to stop hands it over
// first; one that just went away would leave the node owed for an answer it holds no signature for.
slowVouchers = true;
await ask('llama-3.3-70b');
const lastPaid = router.trips[router.trips.length - 1];
const paidNode = nodes.findIndex((n) => n.pda.toBase58() === lastPaid.provider);
const stands = async () => (await (await fetch(`http://127.0.0.1:${providerSpecs[paidNode].port}/orrery/channel?address=${channels.get(lastPaid.provider)!.channel}`)).json()) as { paid: string; owed: string };
const onItsWay = await stands();
const stillOut = await (router as unknown as { drain?: (ms?: number) => Promise<number> }).drain?.(5_000);
const handedOver = await stands();
slowVouchers = false;
check('a router told to stop first hands over the vouchers still on their way, so no node is left owed for an answer it holds no signature for', stillOut === 0 && BigInt(onItsWay.owed) > BigInt(onItsWay.paid) && BigInt(handedOver.owed) === BigInt(handedOver.paid), `right after the answer ${nameOf(lastPaid.provider)} was owed ${onItsWay.owed} and held a voucher for ${onItsWay.paid}; ${stillOut === undefined ? 'this router cannot drain' : `after draining: owed ${handedOver.owed}, holds ${handedOver.paid}`}`);
await new Promise<void>((done) => { recorder.closeAllConnections(); recorder.close(() => done()); });
const tripsWithProxy = router.trips.length;
const proxyGone = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama-3.3-70b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) });
await proxyGone.text();
const rpcGone = await proxiedRpc.getSlot().then(() => 'answered', () => 'refused');
setNodeProxy(null);
for (const o of router.stats.all().values()) o.cooldownUntil = 0;
// Every request that no node answered is in the router's own log of them, and orrery spend says how many and that
// nothing was signed or paid for them.
{
  const { readUnanswered } = await import('../src/spend.ts') as unknown as { readUnanswered?: (p: string) => { at: number; model: string; asked: number }[] };
  const unanswered = readUnanswered?.(join(WORK, 'home/router/unanswered.jsonl')) ?? [];
  const asked = unanswered.reduce((a, u) => a + u.asked, 0);
  const unOut = await new Promise<string>((done) => { let out = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'spend', '--since', '7d'], { stdio: ['ignore', 'pipe', 'ignore'] }); pc.stdout!.on('data', (c) => (out += c)); pc.on('exit', () => done(out.trim())); });
  const unLine = unOut.split('\n').find((l) => /got no answer/.test(l)) ?? '';
  // An agent asking orrery mcp for status is told the same, from a fresh mcp process now that there are some.
  const mcp2 = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'mcp', '--router', ROUTER], { stdio: ['pipe', 'pipe', 'ignore'] });
  const out2: Record<number, { result?: { content?: { text?: string }[] } }> = {};
  let buf2 = '';
  mcp2.stdout!.on('data', (c) => { buf2 += c; let i; while ((i = buf2.indexOf('\n')) >= 0) { const line = buf2.slice(0, i); buf2 = buf2.slice(i + 1); try { const m = JSON.parse(line) as { id?: number }; if (typeof m.id === 'number') out2[m.id] = m as never; } catch { /* not a message */ } } });
  mcp2.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rehearsal', version: '0' } } })}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } })}\n`);
  for (let i = 0; i < 75 && !out2[2]; i++) await sleep(200);
  mcp2.kill();
  const mcpUnLine = (out2[2]?.result?.content?.[0]?.text ?? '').split('\n').find((l) => /got no answer/.test(l)) ?? '';
  // orrery doctor's paid line says the same, beside what was paid.
  const docUnPaid = (await doctor({ rpc: RPC, mint: usdc, wallet: user.publicKey, router: ROUTER, deposit: USD })).find((l) => l.what.trim() === 'paid')?.detail ?? '';
  // And what the router keeps on this computer: the counts are the files' own, and none of them holds a prompt.
  const routerDir = join(WORK, 'home/router');
  const keptSaid = (await doctor({ rpc: RPC, mint: usdc, wallet: user.publicKey, router: ROUTER, deposit: USD, routerHome: routerDir } as Parameters<typeof doctor>[0])).find((l) => l.what === 'kept here')?.detail ?? '';
  const keptTrips = readTrips(join(routerDir, 'trips.jsonl')).length;
  check('orrery doctor says what the router keeps on this computer, counted from its own files, and that no prompt or answer is in it', keptSaid.startsWith(`${routerDir}: ${keptTrips.toLocaleString('en-US')} answers, ${unanswered.length} unanswered requests, a record of `) && keptSaid.endsWith(' · models, token counts, prices and timings, never a prompt or an answer'),
    keptSaid.replace(routerDir, '<router home>').slice(0, 170) || 'no such line in doctor');
  // The router's console says the same under its 24-hour spend: the page carries the note, and what it writes there
  // from this router's /orrery/spend ends with that line.
  const consoleNow = await (await fetch(`${ROUTER}/`)).text();
  const spendNow = await (await fetch(`${ROUTER}/orrery/spend?since=24h&by=model`)).json();
  const consoleMod = await import('../src/router/console.ts') as unknown as { spendNotes?: (sp: unknown) => string };
  const consoleNote = consoleMod.spendNotes?.(spendNow) ?? '';
  check('the router console says under its spend how many requests no node answered, and that nothing was paid for them', consoleNow.includes('id="spendnote"') && consoleNow.includes('const spendNotes=') && consoleNote.endsWith(unLine), consoleNote.slice(-140) || 'no note');
  check('orrery doctor’s paid line says how many requests no node answered, and that nothing was paid for them', unLine.length > 0 && docUnPaid.endsWith(` · ${unLine}`), docUnPaid.slice(-150) || 'no paid line');
  check('an agent is told through orrery mcp how many requests no node answered, and that nothing was paid for them', unanswered.length >= 2 && mcpUnLine === unLine,
    mcpUnLine || 'no such line in the status tool');
  check('orrery spend says how many requests no node answered, from the router’s own log of them, and that nothing was paid for them', unanswered.length >= 2 && unLine === `${unanswered.length} requests got no answer from any node asked${asked > unanswered.length ? ` (${asked} nodes asked in all)` : ''}; nothing was signed or paid for them.`,
    `${unanswered.length} logged · ${unLine || 'no line in orrery spend'}`);
}
check('when no node could answer, the refusal tells the client when to ask again, in the header its SDK already reads', proxyGone.status === 502 && proxyGone.headers.get('retry-after') === '3', `${proxyGone.status} with retry-after: ${proxyGone.headers.get('retry-after')}`);
check('with a proxy set the router reaches nodes only through it: the proxy carries a request it cannot read, and with the proxy gone the request fails instead of going out directly',
  throughProxy.status === 200 && throughProxy.content.length > 20 && tripsAfterThrough === tripsBeforeProxy + 1 && proxyCarried.length >= 1 && proxyCarried.every((x) => x.body.length > 100) && !proxyRead
  && proxyGone.status >= 500 && router.trips.length === tripsWithProxy && /^127\.0\.0\.1:\d+$/.test(statusWithProxy.proxy ?? ''),
  `${proxyCarried.length} request${proxyCarried.length === 1 ? '' : 's'} to a node through the proxy, ${proxyCarried[0]?.body.length ?? 0} sealed bytes for the prompt (${nameOf(proxyTrip?.provider ?? null)}); proxy gone → ${proxyGone.status}`);
check('the Solana RPC goes through the same proxy: reads, and a transaction sent and confirmed by asking for its status with no websocket; with the proxy gone the RPC is not reached',
  proxiedAfter === proxiedBalance + 1_000 && !proxiedTransfer.startsWith('failed') && rpcCalls.includes('sendTransaction') && rpcCalls.includes('getSignatureStatuses') && rpcCalls.includes('getBalance') && rpcGone === 'refused',
  `${rpcCalls.length} RPC calls through the proxy (${[...new Set(rpcCalls)].join(', ')}); proxy gone → ${rpcGone}${proxiedTransfer.startsWith('failed') ? ` · ${proxiedTransfer}` : ''}`);

// The whole path of a new operator, with the real CLI in a home folder that has never seen Orrery or the Solana
// tools: a wallet, a config, one transaction, a running node, and a router that never heard of it paying it.
const walkHome = join(WORK, 'walk-in');
mkdirSync(walkHome, { recursive: true });
const walkEnv = Object.fromEntries(Object.entries({ ...process.env, ORRERY_HOME: join(walkHome, '.orrery'), HOME: walkHome }).filter(([k]) => k !== 'ORRERY_WALLET')) as NodeJS.ProcessEnv;
const walkRun = (args: string[]) => new Promise<{ code: number | null; text: string; ms: number }>((done) => { const t0 = Date.now(); let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: walkEnv }); pc.stdout!.on('data', (c) => (text += c)); pc.stderr!.on('data', (c) => (text += c)); pc.on('exit', (code) => done({ code, text: text.split('\n').filter((l) => !l.startsWith('bigint:')).join('\n'), ms: Date.now() - t0 })); });
const walkCfg = join(walkHome, 'provider.json');
let walkKey: string | undefined;
const walkKey0 = () => walkKey;
const walk1 = await walkRun(['wallet', 'new']);
const walkWallet = /address {2}(\S+)/.exec(walk1.text)?.[1];
// The one deposit an operator makes. Here it is an airdrop; on mainnet it is a withdrawal from wherever their SOL is.
if (walkWallet) await fund(new PublicKey(walkWallet), 1);
const walk2 = await walkRun(['provider', 'init', '--offline', '--upstream', 'http://127.0.0.1:19102/v1', '--name', 'Walk-in Node', '--public-url', 'http://127.0.0.1:17288', '--rpc', RPC, '--out', walkCfg]);
// The draft is written for mainnet. The rehearsal points it at its own validator, its own USDC and a free port, and
// edits nothing else: the wallet, the models, the prices and the data folder are as init wrote them.
if (existsSync(walkCfg)) writeFileSync(walkCfg, JSON.stringify({ ...(JSON.parse(readFileSync(walkCfg, 'utf8')) as object), rpcUrl: RPC, settleMint: usdc.toBase58(), listen: 17288 }, null, 2));
const walk3 = await walkRun(['provider', 'register', '--config', walkCfg, '--rpc', RPC, '--fund-key']);
walkKey = /to the node’s key (\S+) /.exec(walk3.text)?.[1];
let walkStarted = '';
const walkT0 = Date.now();
const walkNode = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'start', '--config', walkCfg, '--rpc', RPC], { stdio: ['ignore', 'pipe', 'pipe'], env: walkEnv });
walkNode.stdout!.on('data', (c) => (walkStarted += c));
walkNode.stderr!.on('data', (c) => (walkStarted += c));
for (let i = 0; i < 150 && !/\n(next|ready)[: ]/.test(`\n${walkStarted}`); i++) await sleep(200);
const walkStartMs = Date.now() - walkT0;
const walkSaid = walkStarted.split('\n').find((l) => /^(next|ready)/.test(l)) ?? 'started without a word about what is left';
// A router that has never heard of this node reads the chain again and is asked for a model only this node lists.
await registry.refresh();
const walkListing = walkWallet ? pda.provider(new PublicKey(walkWallet)).toBase58() : '';
const walkAskT0 = Date.now();
const walkAsk = await fetch(`${ROUTER}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'llama3.1-8b', max_tokens: 16, messages: [{ role: 'user', content: 'Say hi.' }] }) });
const walkAnswer = await walkAsk.text();
const walkAskMs = Date.now() - walkAskT0;
const walkCost = walkAsk.headers.get('x-orrery-cost');
await sleep(600); // the voucher for that answer follows it
// Before its first payout the node says what that payout costs it: the wallet `orrery wallet new` made has no USDC account.
const walk4 = await walkRun(['provider', 'check', '--json', '--config', walkCfg, '--rpc', RPC]);
const walkKeyLine = ((): { ok: boolean | null; detail: string } | undefined => { try { return (JSON.parse(walk4.text.slice(walk4.text.indexOf('['))) as { what: string; ok: boolean | null; detail: string }[]).find((l) => l.what === 'node key'); } catch { return undefined; } })();
const walkUsdcBefore = walkWallet ? await conn.getAccountInfo(pda.ata(new PublicKey(walkWallet), usdc)) : null;
// A key that holds fee money but not the rent of that account: the first payout fails, and the node says why.
const walkNodeKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(walkHome, '.orrery', 'provider', 'node.json'), 'utf8'))));
const walkKeyHad = await conn.getBalance(walkNodeKey.publicKey);
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: walkNodeKey.publicKey, toPubkey: admin.publicKey, lamports: walkKeyHad - 1_000_000 - 5_000 })), [walkNodeKey]);
const walkShort = await walkRun(['provider', 'redeem', '--config', walkCfg, '--rpc', RPC]);
const walkShortAccount = walkWallet ? await conn.getAccountInfo(pda.ata(new PublicKey(walkWallet), usdc)) : null;
const walkShortLine = walkShort.text.split('\n').find((l) => l.startsWith('redeem failed')) ?? '';
check('a first payout the node key cannot cover, because it also opens the wallet’s USDC account, fails in plain words: what it takes, what the key has, and that what routers signed is safe',
  !walkShortAccount && /the first payout also opens your wallet’s USDC account, which takes about 0\.00\d+ SOL from the node key, and it has 0\.0010 SOL/.test(walkShortLine) && /What routers signed is safe/.test(walkShortLine),
  (walkShortLine || walkShort.text.trim().split('\n').slice(-1)[0] || 'no line').replace(/[1-9A-HJ-NP-Za-km-z]{43,88}/g, '<…>').replace(/^.*?; /, '… ').slice(0, 150));
// Topped back up to what --fund-key sent, and the payout goes through.
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: walkNodeKey.publicKey, lamports: walkKeyHad - (await conn.getBalance(walkNodeKey.publicKey)) })), [admin]);
const walkKeyBefore = walkKey0() ? await conn.getBalance(new PublicKey(walkKey0()!)) : 0;
const walkRedeem = await walkRun(['provider', 'redeem', '--config', walkCfg, '--rpc', RPC]);
const walkUsdc = walkWallet ? await conn.getTokenAccountBalance(pda.ata(new PublicKey(walkWallet), usdc)).then((b) => b.value.amount, () => null) : null;
const walkKeyAfter = walkKey0() ? await conn.getBalance(new PublicKey(walkKey0()!)) : 0;
const walk5 = await walkRun(['provider', 'earnings', '--config', walkCfg, '--rpc', RPC]);
walkNode.kill();
// What --fund-key put on the key, read before the first payout spent any of it.
const walkKeyLamports = walkKey ? walkKeyBefore : -1;
const walkMask = (t: string) => t.split(walkHome).join('~').replace(/[1-9A-HJ-NP-Za-km-z]{43,88}/g, '<…>').trim().split('\n');
writeFileSync(join(WORK, 'walk-in.json'), JSON.stringify({
  steps: [
    { typed: 'orrery wallet new', ms: walk1.ms, exit: walk1.code, said: walkMask(walk1.text) },
    { typed: 'orrery provider init', ms: walk2.ms, exit: walk2.code, said: walkMask(walk2.text) },
    { typed: 'orrery provider register --config provider.json --fund-key', ms: walk3.ms, exit: walk3.code, said: walkMask(walk3.text) },
    { typed: 'orrery provider start --config provider.json', ms: walkStartMs, said: walkMask(walkStarted) },
  ],
  firstPaidAnswer: { status: walkAsk.status, ms: walkAskMs, cost: walkCost, node: walkAsk.headers.get('x-orrery-provider-name'), found: walkAsk.headers.get('x-orrery-provider') === walkListing },
  firstPayout: { usdcAccountBefore: !!walkUsdcBefore, walletUsdcUnitsAfter: walkUsdc, nodeKeyPaidLamports: walkKeyBefore - walkKeyAfter, said: walkMask(walkRedeem.text), checkSaid: walkKeyLine?.detail.replace(/[1-9A-HJ-NP-Za-km-z]{43,44}/g, '<…>') ?? null },
  earnings: walkMask(walk5.text), nodeKeyLamports: walkKeyLamports, machineMs: walk1.ms + walk2.ms + walk3.ms + walkStartMs + walkAskMs,
}, null, 1));
check('the first payout lands in a wallet that never made a USDC account: the node’s key opens it, and the node says so before it pays',
  !walkUsdcBefore && walkRedeem.code === 0 && walkUsdc !== null && Number(walkUsdc) === Math.round(Number(walkCost) * 1e6) && walkKeyBefore - walkKeyAfter > 2_000_000 && /first payout also opens your wallet’s USDC account/.test(walkKeyLine?.detail ?? '') && /sent 0\.0100 SOL .*the first also opens your wallet’s USDC account/.test(walk3.text),
  `USDC account before: ${walkUsdcBefore ? 'yes' : 'none'} · redeem ${walkRedeem.code}: ${walkRedeem.text.trim().split('\n')[0]?.replace(/[1-9A-HJ-NP-Za-km-z]{43,44}/g, '<…>').slice(0, 50)} · wallet now holds ${walkUsdc ?? 'nothing'} units · the key paid ${((walkKeyBefore - walkKeyAfter) / 1e9).toFixed(6)} SOL · check said: ${(walkKeyLine?.detail ?? 'no node key line').replace(/[1-9A-HJ-NP-Za-km-z]{43,44}/g, '<…>').slice(0, 90)}`);
check('provider init asks only for what is still missing: the public address given to it is not asked for again', walk2.text.includes('1. check your prices in') && !walk2.text.includes('set publicUrl'), (walk2.text.split('\n').find((l) => /^ {2}1\. /.test(l)) ?? 'no first step').trim().replace(walkHome, '~').slice(0, 120));
// The same operator running the node in Docker: the wallet stays out of the container, its address goes in.
const walkCompose = join(walkHome, 'docker-compose.yml');
const walkComposed = await walkRun(['provider', 'compose', '--config', walkCfg, '--out', walkCompose, '--force']);
const walkComposeText = existsSync(walkCompose) ? readFileSync(walkCompose, 'utf8') : '';
check('provider compose gives a container node its wallet’s address, so a config that names only a wallet file still finds its listing there', walkComposed.code === 0 && walkComposeText.includes(`ORRERY_AUTHORITY=${walkWallet}`) && !walkComposeText.includes('wallet.json:'), `${walkComposeText.includes('ORRERY_AUTHORITY=') ? 'ORRERY_AUTHORITY=<the wallet’s address>' : 'no address for the node'} · wallet file mounted: ${walkComposeText.includes('wallet.json:') ? 'yes' : 'no'}`);
// A node that knows its wallet only by address (a container, a cold wallet) sends the register step to where the wallet is.
const awayCfg = join(walkHome, 'provider-away.json');
writeFileSync(awayCfg, JSON.stringify({ ...(JSON.parse(readFileSync(walkCfg, 'utf8')) as object), wallet: join(walkHome, 'not-here', 'wallet.json'), dataDir: join(walkHome, 'away-data') }, null, 2));
const awayAddress = Keypair.generate().publicKey.toBase58();
const awayCheck = await new Promise<string>((done) => { let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'check', '--config', awayCfg, '--rpc', RPC], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...walkEnv, ORRERY_AUTHORITY: awayAddress } }); pc.stdout!.on('data', (c) => (text += c)); pc.stderr!.on('data', (c) => (text += c)); pc.on('exit', () => done(text)); });
const awayNext = awayCheck.split('\n').find((l) => l.startsWith('next:')) ?? '';
// A model server that says how much context it serves (vLLM's max_model_len, here 8,192): init lists that, and a
// provider.json that lists more is caught by provider check before routers send it requests that fail.
const ctxMock = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/devtools/mock-upstream.ts'), '19109', '5', 'served-context'], { stdio: 'ignore', env: { ...process.env, MOCK_MODELS: 'Qwen/Qwen3-32B', MOCK_MAX_MODEL_LEN: '8192' } });
procs.push(ctxMock);
await sleep(1_200);
// provider init takes the payout webhook at the start: it writes notify into provider.json and says where notices go;
// an address that is not http(s) stops it before anything is written.
const hookCfgPath = join(walkHome, 'provider-notify.json'), badHookPath = join(walkHome, 'provider-badhook.json');
const hookInit = await walkRun(['provider', 'init', '--offline', '--upstream', 'http://127.0.0.1:19109/v1', '--out', hookCfgPath, '--notify', 'http://127.0.0.1:9/hooks/init']);
const badHook = await walkRun(['provider', 'init', '--offline', '--upstream', 'http://127.0.0.1:19109/v1', '--out', badHookPath, '--notify', 'ftp://hooks.example.com/x']);
const hookCfg = existsSync(hookCfgPath) ? JSON.parse(readFileSync(hookCfgPath, 'utf8')) as { notify?: { url?: string } } : null;
check('orrery provider init takes a payout webhook with --notify and writes it into provider.json, and refuses one that is not http(s)',
  hookInit.code === 0 && hookCfg?.notify?.url === 'http://127.0.0.1:9/hooks/init' && hookInit.text.includes("payout notices: each payout's arrival") && hookInit.text.includes('go to 127.0.0.1:9;')
  && badHook.code !== 0 && badHook.text.includes('must start with https:// or http://') && !existsSync(badHookPath),
  `${hookCfg?.notify?.url ?? 'no notify written'} · bad address: exit ${badHook.code}, ${existsSync(badHookPath) ? 'file written' : 'nothing written'}`);
const ctxCfgPath = join(walkHome, 'provider-context.json');
const ctxInit = await walkRun(['provider', 'init', '--offline', '--upstream', 'http://127.0.0.1:19109/v1', '--out', ctxCfgPath, '--force']);
const ctxCfg = existsSync(ctxCfgPath) ? JSON.parse(readFileSync(ctxCfgPath, 'utf8')) as { models: { id: string; context: number; maxOutput: number }[] } : null;
check('orrery provider init lists the context the model server says it serves, and leaves room for the answer', ctxInit.code === 0 && ctxCfg?.models.length === 1 && ctxCfg.models[0].id === 'qwen3-32b' && ctxCfg.models[0].context === 8192 && ctxCfg.models[0].maxOutput === 2048, ctxCfg ? ctxCfg.models.map((m) => `${m.id} context ${m.context} · max output ${m.maxOutput}`).join(', ') : ctxInit.text.slice(0, 120));
writeFileSync(ctxCfgPath, JSON.stringify({ ...(ctxCfg as object), rpcUrl: RPC, publicUrl: 'http://127.0.0.1:17991', dataDir: join(walkHome, 'context-data'), models: (ctxCfg?.models ?? []).map((m) => ({ ...m, context: 32_768, maxOutput: 4_096 })) }, null, 2));
const ctxCheck = await walkRun(['provider', 'check', '--config', ctxCfgPath, '--rpc', RPC]);
const ctxLine = ctxCheck.text.split('\n').find((l) => /^\S context /.test(l)) ?? '';
check('orrery provider check says when provider.json lists more context than the model server serves', /^· context +provider\.json lists 32,768 tokens of context for qwen3-32b, but the model server serves 8,192\. Longer requests fail there and count against this node: set "context" to 8,192 or less$/.test(ctxLine), ctxLine.slice(0, 160) || 'no context line');
// The same listing with maxOutput as large as its context: nothing left for a prompt. Check says so, as a failure.
writeFileSync(ctxCfgPath, JSON.stringify({ ...(JSON.parse(readFileSync(ctxCfgPath, 'utf8')) as object), models: (ctxCfg?.models ?? []).map((m) => ({ ...m, context: 8_192, maxOutput: 8_192 })) }, null, 2));
const roomCheck = await walkRun(['provider', 'check', '--config', ctxCfgPath, '--rpc', RPC]);
const roomLine = roomCheck.text.split('\n').find((l) => /^\S max output /.test(l)) ?? '';
check('orrery provider check fails a listing whose maxOutput leaves no room for the prompt, and says what to set', /^✗ max output +qwen3-32b lists a maxOutput of 8,192 in a context of 8,192: nothing is left for the prompt, .* Set maxOutput to a quarter of context or less \(2,048\)$/.test(roomLine), roomLine.slice(0, 150) || 'no max output line');
ctxMock.kill('SIGTERM');
// A model server that answers /models the way Ollama does (owned_by "library"), given to init with --upstream: init
// knows it for Ollama, lists a context Ollama reads whole, and says how to raise it.
const ollamaLike = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/devtools/mock-upstream.ts'), '19110', '5', 'ollama-like'], { stdio: 'ignore', env: { ...process.env, MOCK_MODELS: 'llama3.1:8b', MOCK_OWNED_BY: 'library' } });
procs.push(ollamaLike);
await sleep(1_200);
const olPath = join(walkHome, 'provider-ollama.json');
const olInit = await walkRun(['provider', 'init', '--offline', '--upstream', 'http://127.0.0.1:19110/v1', '--out', olPath, '--force']);
const olCfg = existsSync(olPath) ? JSON.parse(readFileSync(olPath, 'utf8')) as { models: { id: string; context: number; maxOutput: number }[] } : null;
ollamaLike.kill('SIGTERM');
check('orrery provider init knows Ollama by its answer, lists a context Ollama reads whole, and says how to raise it', /^found Ollama at http:\/\/127\.0\.0\.1:19110\/v1/.test(olInit.text.split('\n').find((l) => l.startsWith('found')) ?? '') && olCfg?.models[0]?.context === 4096 && olCfg.models[0]?.maxOutput === 1024 && olInit.text.includes('drops the rest without an error, so provider.json lists 4,096 tokens'),
  `${(olInit.text.split('\n').find((l) => l.startsWith('found')) ?? 'no found line').slice(0, 60)} · ${olCfg ? olCfg.models.map((m) => `${m.id} context ${m.context} · max output ${m.maxOutput}`).join(', ') : 'no file'} · ${olInit.text.includes('OLLAMA_CONTEXT_LENGTH') ? 'says how to raise it' : 'says nothing about it'}`);
check('a node that knows its wallet only by its address sends the register step to the computer that has the wallet', /^next: list the node on chain, on the computer that has your wallet \(\S+wallet\.json\): \S+ provider register --config /.test(awayNext) && !awayNext.includes('<keypair.json>'), awayNext.split(walkHome).join('~').slice(0, 150) || 'no next line');
// The same home folder, with no router running: doctor says to start one the way it starts now, without --wallet.
const walkDoctor = await walkRun(['doctor', '--rpc', RPC, '--mint', usdc.toBase58(), '--router', 'http://127.0.0.1:17996']);
const walkDoctorRouter = walkDoctor.text.split('\n').find((l) => /\brouter\s+not running/.test(l)) ?? '';
check('orrery doctor, with the wallet orrery wallet new made, says to start the router without --wallet', /start it with \S+ router$/.test(walkDoctorRouter.trim()) && !walkDoctorRouter.includes('<keypair.json>'), walkDoctorRouter.trim().slice(0, 120) || 'no router line');
check('a new node, once it is ready, is told its first payout goes out at the next round after its first answer', /^ready to earn: .*\. Its first payout goes out at the next round after its first answer \(every 5 min\)$/.test(walkSaid), walkSaid.slice(0, 160));
check('orrery wallet new, at the default place, says what comes next without --wallet, since that is the wallet everything uses', /\nthen {2}\S+ router {3}uses this wallet\n/.test(walk1.text) && !/router --wallet|doctor --wallet|init --wallet/.test(walk1.text), (walk1.text.split('\n').find((l) => l.startsWith('then')) ?? 'no then line').trim().slice(0, 100));
check('a new operator with no Solana tools goes from nothing to a paid answer with four commands and one deposit: wallet new, provider init, register --fund-key, provider start',
  walk1.code === 0 && !!walkWallet && walk2.code === 0 && walletOf(walkCfg) === join(walkHome, '.orrery', 'wallet.json') && walk3.code === 0 && walkKeyLamports === 10_000_000
  && /^ready to earn/.test(walkSaid) && walkAsk.status === 200 && walkAsk.headers.get('x-orrery-provider') === walkListing && Number(walkCost) > 0,
  `wallet new ${walk1.code} · init ${walk2.code} · register ${walk3.code}, key ${walkKeyLamports < 0 ? 'unfunded' : `${(walkKeyLamports / 1e9).toFixed(4)} SOL`} · start: ${walkSaid.slice(0, 60)} · a router that had never seen it: ${walkAsk.status}${walkAsk.status === 200 ? ` from ${walkAsk.headers.get('x-orrery-provider-name')}, paid $${walkCost}` : ` ${walkAnswer.slice(0, 120)}`} · ${((walk1.ms + walk2.ms + walk3.ms + walkStartMs + walkAskMs) / 1000).toFixed(1)} s of machine time`);

// One address to fund: the listing wallet sends the node's key its fee money in the register transaction.
await fund(brokeWallet.publicKey, 1);
const fundedOut = await new Promise<{ code: number | null; text: string }>((done) => { let text = ''; const pc = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'node/src/cli.ts'), 'provider', 'register', '--config', join(brokeDir, 'provider.json'), '--rpc', RPC, '--fund-key', '0.02'], { stdio: ['ignore', 'pipe', 'pipe'] }); pc.stdout!.on('data', (c) => (text += c)); pc.stderr!.on('data', (c) => (text += c)); pc.on('exit', (code) => done({ code, text })); });
const fundedKey = /to the node’s key (\S+) /.exec(fundedOut.text)?.[1];
const fundedLamports = fundedKey ? await conn.getBalance(new PublicKey(fundedKey)) : -1;
const fundedListed = await conn.getAccountInfo(pda.provider(brokeWallet.publicKey));
check('orrery provider register --fund-key lists the node and sends its key fee money in the same transaction, so a new operator funds one address', fundedOut.code === 0 && !!fundedListed && fundedLamports === 20_000_000 && /sent 0\.0200 SOL to the node’s key/.test(fundedOut.text), `exit ${fundedOut.code} · listed: ${fundedListed ? 'yes' : 'no'} · node key holds ${fundedLamports < 0 ? 'unknown' : `${(fundedLamports / 1e9).toFixed(4)} SOL`} · ${(fundedOut.text.split('\n').find((l) => l.startsWith('sent')) ?? 'no line about the key').replace(fundedKey ?? '-', '<key>').slice(0, 90)}`);

// What that one transaction did, as the chain recorded it: for the record, and for anyone who wants to check the claim.
const fundedSig = /tx (\S+)/.exec(fundedOut.text)?.[1];
const fundedTx = fundedSig ? await conn.getTransaction(fundedSig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }) : null;
if (fundedTx?.meta && fundedListed) {
  const keys = fundedTx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  const moved = (who: string) => { const i = keys.indexOf(who); return i < 0 ? null : fundedTx.meta!.postBalances[i] - fundedTx.meta!.preBalances[i]; };
  writeFileSync(join(WORK, 'fund-key.json'), JSON.stringify({
    instructions: fundedTx.transaction.message.compiledInstructions.length, signatures: fundedTx.transaction.signatures.length, feeLamports: fundedTx.meta.fee,
    wallet: moved(brokeWallet.publicKey.toBase58()), listing: moved(pda.provider(brokeWallet.publicKey).toBase58()), nodeKey: fundedKey ? moved(fundedKey) : null,
    listingBytes: fundedListed.data.length, said: fundedOut.text.trim().split('\n').map((l) => l.replace(/[1-9A-HJ-NP-Za-km-z]{43,88}/g, '<…>')),
  }, null, 1));
}

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
