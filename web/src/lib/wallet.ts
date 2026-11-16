// Server only. What one wallet did on Orrery, read from the program's accounts on Solana through the site's RPC
// (SOLANA_RPC_URL, never sent to the browser). Each address is read at most once every five minutes. Every node's
// account is read in one list that all address pages share for five minutes, so a page asks the chain only for what
// is this address's own: the channels it paid into, its balances, and (for a node) its account and its channels.
import { unstable_cache } from 'next/cache';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from '@/brand';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type WalletChannel = {
  address: string;
  payer: string;
  provider: string;
  providerName: string | null;
  deposit: string;
  redeemed: string;
  openedAt: number;
  closingAt: number;
};

export type WalletNode = {
  address: string;
  name: string | null;
  endpoint: string;
  models: string[];
  active: boolean;
  enclave: boolean;
  settled: string;
  redeems: number;
  channels: number;
  bonded: string;
  registeredAt: number;
  lastSettledAt: number;
  routers: WalletChannel[];
};

export type Wallet = {
  checked: boolean;
  at: string;
  address: string;
  isNode: boolean;
  sol: number | null;
  usdc: string | null;
  channels: WalletChannel[];
  nodes: WalletNode[];
};

type Gpa = { pubkey: string; account: { data: [string, string] } }[];

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: T };
  return body.result ?? null;
}

type Decoders = {
  ACCOUNT: { Provider: Buffer; Channel: Buffer };
  decodeChannel: (b: Buffer) => { payer: PublicKey; provider: PublicKey; deposit: bigint; redeemed: bigint; openedAt: bigint; closingAt: bigint };
  decodeProvider: (b: Buffer) => {
    authority: PublicKey; endpoint: string; active: boolean; teeKind: number; bonded: bigint; settled: bigint; redeems: bigint;
    channels: bigint; registeredAt: bigint; lastSettledAt: bigint;
  };
};

const gpa = (disc: Buffer, offset: number, key: string) =>
  rpc<Gpa>('getProgramAccounts', [
    PROGRAM_ID,
    { encoding: 'base64', filters: [{ memcmp: { offset: 0, bytes: disc.toString('base64'), encoding: 'base64' } }, { memcmp: { offset, bytes: key } }] },
  ]);

const NODES = Symbol.for('orrery.web.node-accounts');
export const NODES_KEPT_MS = 5 * 60_000;
type HeldNodes = { at: number; list: Promise<Gpa | null> };

/** Every provider account of the program, read once and shared by every address page for five minutes. A read that
 * fails is not kept. */
export function nodeAccounts(disc: Buffer, read: () => Promise<Gpa | null> = () => rpc<Gpa>('getProgramAccounts', [PROGRAM_ID, { encoding: 'base64', filters: [{ memcmp: { offset: 0, bytes: disc.toString('base64'), encoding: 'base64' } }] }]), now = Date.now()): Promise<Gpa | null> {
  const box = globalThis as unknown as Record<symbol, HeldNodes | undefined>;
  const held = box[NODES];
  if (held && now - held.at < NODES_KEPT_MS) return held.list;
  const list = read();
  box[NODES] = { at: now, list };
  const drop = () => {
    if (box[NODES]?.list === list) box[NODES] = undefined;
  };
  list.then((l) => (l ? undefined : drop()), drop);
  return list;
}

/** The node accounts whose authority (bytes 8..40, after the account type) is `address`: what a getProgramAccounts
 * filtered on that offset returns, picked from the shared list. */
export function ownedBy(list: Gpa, address: string): Gpa {
  const key = new PublicKey(address).toBuffer();
  return list.filter((a) => Buffer.from(a.account.data[0], 'base64').subarray(8, 40).equals(key));
}

async function manifestOf(endpoint: string): Promise<{ name: string | null; models: string[] }> {
  try {
    const r = await fetch(`${endpoint.replace(/\/$/, '')}/v1/manifest`, { signal: AbortSignal.timeout(4_000) });
    if (!r.ok) return { name: null, models: [] };
    const m = (await r.json()) as { name?: string; models?: { id: string }[] };
    return { name: typeof m.name === 'string' ? m.name.slice(0, 60) : null, models: (m.models ?? []).map((x) => String(x.id).slice(0, 60)).slice(0, 20) };
  } catch {
    return { name: null, models: [] };
  }
}

async function read(address: string): Promise<Wallet> {
  const at = new Date().toISOString();
  const empty: Wallet = { checked: false, at, address, isNode: false, sol: null, usdc: null, channels: [], nodes: [] };
  if (!process.env.SOLANA_RPC_URL) return empty;
  try {
    const { ACCOUNT, decodeChannel, decodeProvider } = (await import('orrery-node/dist/chain/program.js')) as unknown as Decoders;
    const [paid, all] = await Promise.all([gpa(ACCOUNT.Channel, 8, address), nodeAccounts(ACCOUNT.Provider)]);
    if (!paid || !all) return empty;
    // A node's own page shows its payouts, so its account is still read fresh; balances are shown only for a wallet.
    const isNode = all.some((a) => a.pubkey === address);
    const [self, sol, usdc] = isNode
      ? [await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64' }]), null, null]
      : await Promise.all([
          null,
          rpc<{ value: number }>('getBalance', [address]),
          rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [address, { mint: USDC }, { encoding: 'jsonParsed' }]),
        ]);
    if (isNode && !self?.value) return empty;
    const mine: Gpa = isNode ? [{ pubkey: address, account: { data: [self!.value!.data[0], 'base64'] } }] : ownedBy(all, address);

    const providerKeys = [...new Set(paid.map((a) => decodeChannel(Buffer.from(a.account.data[0], 'base64')).provider.toBase58()))].slice(0, 12);
    const byKey = new Map(all.map((a) => [a.pubkey, a.account.data[0]]));
    const names = new Map<string, string | null>();
    await Promise.all(
      providerKeys.map(async (k) => {
        const data = byKey.get(k);
        if (!data) return names.set(k, null);
        const p = decodeProvider(Buffer.from(data, 'base64'));
        names.set(k, (await manifestOf(p.endpoint)).name);
      }),
    );

    const toChannel = (a: Gpa[number], name: string | null): WalletChannel => {
      const c = decodeChannel(Buffer.from(a.account.data[0], 'base64'));
      return {
        address: a.pubkey, payer: c.payer.toBase58(), provider: c.provider.toBase58(), providerName: name,
        deposit: c.deposit.toString(), redeemed: c.redeemed.toString(), openedAt: Number(c.openedAt), closingAt: Number(c.closingAt),
      };
    };
    const channels = paid.map((a) => toChannel(a, names.get(decodeChannel(Buffer.from(a.account.data[0], 'base64')).provider.toBase58()) ?? null)).sort((x, y) => y.openedAt - x.openedAt);

    const nodes: WalletNode[] = await Promise.all(
      mine.slice(0, 4).map(async (a) => {
        const p = decodeProvider(Buffer.from(a.account.data[0], 'base64'));
        const [m, into] = await Promise.all([manifestOf(p.endpoint), gpa(ACCOUNT.Channel, 40, a.pubkey)]);
        return {
          address: a.pubkey, name: m.name, endpoint: p.endpoint, models: m.models, active: p.active, enclave: p.teeKind !== 0,
          settled: p.settled.toString(), redeems: Number(p.redeems), channels: Number(p.channels), bonded: p.bonded.toString(),
          registeredAt: Number(p.registeredAt), lastSettledAt: Number(p.lastSettledAt),
          routers: (into ?? []).map((c) => toChannel(c, m.name)).sort((x, y) => y.openedAt - x.openedAt).slice(0, 50),
        };
      }),
    );

    const usdcUnits = (usdc?.value ?? []).reduce((s, t) => s + BigInt(t.account.data.parsed.info.tokenAmount.amount), 0n);
    return { checked: true, at, address, isNode, sol: isNode ? null : sol ? sol.value / 1e9 : null, usdc: isNode ? null : usdc ? usdcUnits.toString() : null, channels, nodes };
  } catch {
    return empty;
  }
}

export function validAddress(s: string): string | null {
  try {
    const k = new PublicKey(s);
    return k.toBase58() === s ? s : null;
  } catch {
    return null;
  }
}

export const wallet = (address: string) => unstable_cache(() => read(address), ['wallet-v1', address], { revalidate: 300 })();
