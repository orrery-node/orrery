// Mainnet launch helpers. Every command that writes to the chain prints its plan and stops unless --yes is given.
//   npx tsx devtools/mainnet.ts status   [--dev <keypair.json>]
//   npx tsx devtools/mainnet.ts init     --dev <keypair.json> [--yes]       (upgrade authority only)
//   npx tsx devtools/mainnet.ts fund     --dev <keypair.json> [--sol 0.03] [--usdc 1] [--node-sol 0.02] [--yes]
//   npx tsx devtools/mainnet.ts smoke    [--n 4] [--yes]                     (test wallet → live providers)
//   npx tsx devtools/mainnet.ts settle   --dev <keypair.json> [--yes]       (redeem + close test channels, sweep back)
// Keys live under .local/keys (git-ignored): test-wallet.json, seed-node.json. RPC: --rpc or ORRERY_RPC_URL, else the
// public mainnet endpoint.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const ROOT = new URL('../../', import.meta.url).pathname;
const KEYS = join(ROOT, '.local/keys');
const HOME = join(ROOT, '.local/mainnet/home');
mkdirSync(HOME, { recursive: true });
process.env.ORRERY_HOME = HOME;

const { PROGRAM_ID, USDC_MAINNET } = await import('../src/brand.ts');
const { decodeChannel, decodeConfig, decodeProvider, ins, pda, programId } = await import('../src/chain/program.ts');
const { decodeVoucher, redeemInstructions } = await import('../src/chain/voucher.ts');
const { loadKeypair, loadOrCreateKeypair } = await import('../src/keys.ts');
const { Channels } = await import('../src/router/channels.ts');
const { Registry } = await import('../src/router/registry.ts');
const { Router } = await import('../src/router/server.ts');
const { usd } = await import('../src/pricing.ts');

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const yes = argv.includes('--yes');
const expand = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
const rpc = flag('rpc', process.env.ORRERY_RPC_URL ?? 'https://api.mainnet-beta.solana.com')!;
const conn = new Connection(rpc, 'confirmed');
const USDC = new PublicKey(USDC_MAINNET);
const SOL = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(6);
const dev = () => {
  const p = flag('dev');
  if (!p) throw new Error('--dev <keypair.json> is required (the deployer wallet, which is the upgrade authority)');
  return loadKeypair(expand(p));
};
const testWallet = () => loadOrCreateKeypair(join(KEYS, 'test-wallet.json'));
const seedNode = () => loadOrCreateKeypair(join(KEYS, 'seed-node.json'));

const usdcOf = async (owner: PublicKey) => {
  try {
    return (await getAccount(conn, getAssociatedTokenAddressSync(USDC, owner, true))).amount;
  } catch {
    return 0n;
  }
};

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  if (!yes) {
    console.log(`  (dry run) ${label}: ${ixs.length} instruction(s), fee payer ${signers[0].publicKey.toBase58()}. Add --yes to send.`);
    return null;
  }
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  console.log(`  ${label}  tx ${sig}`);
  return sig;
}

async function upgradeAuthority(): Promise<PublicKey | null | undefined> {
  const prog = await conn.getAccountInfo(programId());
  if (!prog) return undefined;
  const data = await conn.getAccountInfo(pda.programData());
  if (!data) return undefined;
  return data.data[12] === 1 ? new PublicKey(data.data.subarray(13, 45)) : null;
}

async function status() {
  console.log(`rpc      ${new URL(rpc).host}`);
  console.log(`program  ${PROGRAM_ID}`);
  const auth = await upgradeAuthority();
  console.log(`  deployed: ${auth === undefined ? 'no' : 'yes'}${auth ? `, upgrade authority ${auth.toBase58()}` : auth === null ? ', immutable' : ''}`);
  const cfgInfo = await conn.getAccountInfo(pda.config());
  if (cfgInfo) {
    const c = decodeConfig(cfgInfo.data);
    console.log(`  config: admin ${c.admin.toBase58()}, settle ${c.settleMint.toBase58()}, grace ${c.closeGraceSecs}s, unbond ${c.unbondSecs}s, min deposit $${usd(c.minDeposit, 2)}`);
    console.log(`          ${c.providers} providers, ${c.channels} channels, $${usd(c.settled)} settled, bond mint ${c.bondMint.equals(PublicKey.default) ? 'not set' : c.bondMint.toBase58()}`);
  } else console.log('  config: not initialized');
  const rows: [string, PublicKey][] = [];
  if (flag('dev')) rows.push(['dev', dev().publicKey]);
  rows.push(['test', testWallet().publicKey], ['seed node', seedNode().publicKey]);
  for (const [k, pk] of rows) {
    console.log(`${k.padEnd(10)}${pk.toBase58()}  ${SOL(await conn.getBalance(pk))} SOL  $${usd(await usdcOf(pk), 4)} USDC`);
  }
  if (flag('dev')) {
    const info = await conn.getAccountInfo(pda.provider(dev().publicKey));
    if (info) {
      const p = decodeProvider(info.data);
      console.log(`seed provider ${pda.provider(dev().publicKey).toBase58()}  ${p.active ? 'open' : 'closed'}  ${p.endpoint}  node ${p.nodeKey.toBase58()}  settled $${usd(p.settled)} in ${p.redeems} redeems`);
    } else console.log('seed provider: not listed');
  }
}

async function init() {
  const d = dev();
  const auth = await upgradeAuthority();
  if (auth === undefined) throw new Error('program is not deployed');
  if (!auth || !auth.equals(d.publicKey)) throw new Error(`upgrade authority is ${auth?.toBase58() ?? 'none'}, not the dev wallet ${d.publicKey.toBase58()}`);
  if (await conn.getAccountInfo(pda.config())) throw new Error('already initialized');
  console.log(`initialize: admin ${d.publicKey.toBase58()}, settlement USDC, grace 3600s, unbond 604800s, min deposit $0.10`);
  await send('initialize', [ins.initialize(d.publicKey, USDC, { closeGraceSecs: 3_600n, unbondSecs: 604_800n, minDeposit: 100_000n })], [d]);
}

async function fund() {
  const d = dev();
  const t = testWallet();
  const n = seedNode();
  const sol = Math.round(Number(flag('sol', '0.03')) * LAMPORTS_PER_SOL);
  const nodeSol = Math.round(Number(flag('node-sol', '0.02')) * LAMPORTS_PER_SOL);
  const amount = BigInt(Math.round(Number(flag('usdc', '1')) * 1e6));
  const have = await usdcOf(d.publicKey);
  if (have < amount) throw new Error(`dev wallet holds $${usd(have, 4)} USDC, needs $${usd(amount, 4)}`);
  console.log(`dev ${d.publicKey.toBase58()} → test ${t.publicKey.toBase58()}: ${SOL(sol)} SOL + $${usd(amount, 2)} USDC; → seed node ${n.publicKey.toBase58()}: ${SOL(nodeSol)} SOL`);
  const from = getAssociatedTokenAddressSync(USDC, d.publicKey);
  const to = getAssociatedTokenAddressSync(USDC, t.publicKey);
  await send('fund', [
    SystemProgram.transfer({ fromPubkey: d.publicKey, toPubkey: t.publicKey, lamports: sol }),
    SystemProgram.transfer({ fromPubkey: d.publicKey, toPubkey: n.publicKey, lamports: nodeSol }),
    createAssociatedTokenAccountIdempotentInstruction(d.publicKey, to, t.publicKey, USDC),
    createTransferCheckedInstruction(from, USDC, to, d.publicKey, amount, 6),
  ], [d]);
}

async function smoke() {
  const t = testWallet();
  const session = loadOrCreateKeypair(join(HOME, 'router/session.json'));
  const registry = new Registry(conn, { allowDev: false, measurements: [] });
  const channels = new Channels(conn, t, session, USDC, join(HOME, 'router/channels.json'), { deposit: 300_000n, topUpBelow: 50_000n, dailyCap: 1_000_000n });
  const port = 17371;
  const router = new Router({ port, route: 'price', minReputation: 0, registry, channels, conn, refreshSecs: 3_600, log: (l) => console.log(`  [router] ${l}`) });
  await router.start();
  const usable = registry.usable();
  console.log(`router up: ${usable.length} usable provider(s) on mainnet`);
  for (const e of registry.entries.values()) console.log(`  ${e.address}  ${e.manifest?.name ?? '?'}  ${e.problem ?? 'ok'}`);
  if (!usable.length) {
    await router.close();
    throw new Error('no usable providers: list the seed provider first');
  }
  if (!yes) {
    console.log(`  (dry run) would open a $0.30 channel from the test wallet and send ${flag('n', '4')} requests. Add --yes.`);
    await router.close();
    return;
  }
  const asks: [string, boolean][] = [['gpt-oss-120b:cheap', false], ['llama-3.3-70b', true], ['deepseek-v3', false], ['qwen3-32b', false]];
  const n = Number(flag('n', '4'));
  for (let i = 0; i < n; i++) {
    const [model, stream] = asks[i % asks.length];
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, max_tokens: 120, messages: [{ role: 'user', content: 'In one sentence: what does a payment channel let two parties do?' }] }),
    });
    const text = await r.text();
    const content = stream
      ? text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '').join('')
      : (() => { try { return JSON.parse(text).choices?.[0]?.message?.content ?? text; } catch { return text; } })();
    console.log(`#${i + 1} ${model}${stream ? ' (stream)' : ''} → ${r.status} ${r.headers.get('x-orrery-provider')?.slice(0, 8) ?? ''} $${r.headers.get('x-orrery-cost') ?? '?'}  ${String(content).replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  await router.close();
  for (const c of channels.list()) console.log(`channel ${c.channel}  deposit $${usd(c.deposit, 2)}  signed $${usd(c.cumulative)}`);
  console.log('the provider redeems on its own schedule; `settle` redeems anything left and closes.');
}

async function settle() {
  const d = dev();
  const t = testWallet();
  const node = seedNode();
  const session = loadOrCreateKeypair(join(HOME, 'router/session.json'));
  const channels = new Channels(conn, t, session, USDC, join(HOME, 'router/channels.json'), { deposit: 0n, topUpBelow: 0n, dailyCap: 0n });
  for (const c of channels.list()) {
    const info = await conn.getAccountInfo(new PublicKey(c.channel));
    if (!info) {
      console.log(`channel ${c.channel}: already closed`);
      continue;
    }
    const ch = decodeChannel(info.data);
    const prov = decodeProvider((await conn.getAccountInfo(ch.provider))!.data);
    if (!prov.nodeKey.equals(node.publicKey) && !prov.authority.equals(d.publicKey)) {
      console.log(`channel ${c.channel}: provider ${ch.provider.toBase58()} is not ours; request a close instead (1h grace)`);
      await send('request close', [ins.requestClose(t.publicKey, new PublicKey(c.channel))], [t]);
      continue;
    }
    const ixs: TransactionInstruction[] = [];
    if (c.voucher) {
      const v = decodeVoucher(c.voucher);
      if (v.cumulative > ch.redeemed) {
        console.log(`channel ${c.channel}: redeeming $${usd(v.cumulative - ch.redeemed)} to ${prov.authority.toBase58()}`);
        ixs.push(...redeemInstructions({ caller: node.publicKey, providerAuthority: prov.authority, channel: new PublicKey(c.channel), mint: USDC, sessionKey: ch.sessionKey, voucher: v }));
      }
    }
    ixs.push(ins.closeChannel(node.publicKey, prov.authority, new PublicKey(c.channel), t.publicKey, USDC));
    console.log(`channel ${c.channel}: provider releases it, the rest returns to the test wallet`);
    await send('redeem + close', ixs, [node]);
  }
  const tUsdc = await usdcOf(t.publicKey);
  const tAta = getAssociatedTokenAddressSync(USDC, t.publicKey);
  const sweep: TransactionInstruction[] = [];
  if (existsSync(join(KEYS, 'test-wallet.json')) && (await conn.getAccountInfo(tAta))) {
    if (tUsdc > 0n) sweep.push(createAssociatedTokenAccountIdempotentInstruction(t.publicKey, getAssociatedTokenAddressSync(USDC, d.publicKey), d.publicKey, USDC), createTransferCheckedInstruction(tAta, USDC, getAssociatedTokenAddressSync(USDC, d.publicKey), t.publicKey, tUsdc, 6));
    sweep.push(createCloseAccountInstruction(tAta, d.publicKey, t.publicKey));
  }
  if (sweep.length) {
    console.log(`test wallet: $${usd(tUsdc, 4)} USDC and its token account rent back to dev`);
    await send('sweep USDC', sweep, [t]);
  }
  const lamports = await conn.getBalance(t.publicKey);
  const fee = 5_000;
  if (lamports > fee) {
    console.log(`test wallet: ${SOL(lamports - fee)} SOL back to dev`);
    await send('sweep SOL', [SystemProgram.transfer({ fromPubkey: t.publicKey, toPubkey: d.publicKey, lamports: lamports - fee })], [t]);
  }
}

const cmd = argv[0];
const run = { status, init, fund, smoke, settle }[cmd as 'status'];
if (!run) {
  console.log('usage: mainnet.ts status|init|fund|smoke|settle [--dev <keypair.json>] [--yes]');
  process.exit(1);
}
run().then(() => process.exit(0)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
