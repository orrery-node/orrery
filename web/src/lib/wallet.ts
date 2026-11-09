// Server only. What one wallet did on Orrery, read from the program's accounts on Solana through the site's RPC
// (SOLANA_RPC_URL, never sent to the browser). Each address is read at most once every two minutes.
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
    const [paid, owned, self, sol, usdc] = await Promise.all([
      gpa(ACCOUNT.Channel, 8, address),
      gpa(ACCOUNT.Provider, 8, address),
      rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64' }]),
      rpc<{ value: number }>('getBalance', [address]),
      rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [address, { mint: USDC }, { encoding: 'jsonParsed' }]),
    ]);
    if (!paid || !owned) return empty;
    const selfData = self?.value && self.value.owner === PROGRAM_ID ? Buffer.from(self.value.data[0], 'base64') : null;
    const isNode = !!selfData && selfData.subarray(0, 8).equals(ACCOUNT.Provider);
    const nodeAccounts: Gpa = isNode ? [{ pubkey: address, account: { data: [self!.value!.data[0], 'base64'] } }] : owned;

    const providerKeys = [...new Set(paid.map((a) => decodeChannel(Buffer.from(a.account.data[0], 'base64')).provider.toBase58()))].slice(0, 12);
    const infos = providerKeys.length ? await rpc<{ value: ({ data: [string, string] } | null)[] }>('getMultipleAccounts', [providerKeys, { encoding: 'base64' }]) : null;
    const names = new Map<string, string | null>();
    await Promise.all(
      providerKeys.map(async (k, i) => {
        const info = infos?.value?.[i];
        if (!info) return names.set(k, null);
        const p = decodeProvider(Buffer.from(info.data[0], 'base64'));
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
      nodeAccounts.slice(0, 4).map(async (a) => {
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

export const wallet = (address: string) => unstable_cache(() => read(address), ['wallet-v1', address], { revalidate: 120 })();
