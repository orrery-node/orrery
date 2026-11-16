// Server only. Which nodes on mainnet claim an enclave, read from their accounts on Solana. Cached for ten minutes.
import { unstable_cache } from 'next/cache';
import { providers } from './providers';

const KINDS = ['none', 'Intel TDX', 'AMD SEV-SNP', 'Intel TDX + NVIDIA CC'];
export type PrivateNode = { name: string; address: string; kind: string; image: string };
export type PrivateState = { checked: boolean; at: string; nodes: number; claims: PrivateNode[] };

type Entry = { address: string; account: { teeKind: number; teeMeasurement: Buffer; active: boolean }; manifest: { name: string } | null };

async function read(): Promise<PrivateState> {
  const at = new Date().toISOString();
  const url = process.env.SOLANA_RPC_URL;
  if (!url) return { checked: false, at, nodes: 0, claims: [] };
  try {
    const registry = await providers<{ entries: Map<string, Entry> }>(url);
    const all = [...registry.entries.values()].filter((e) => e.account.active);
    const claims = all.filter((e) => e.account.teeKind > 0).map((e) => ({ name: e.manifest?.name ?? e.address.slice(0, 8), address: e.address, kind: KINDS[e.account.teeKind] ?? 'enclave', image: Buffer.from(e.account.teeMeasurement).toString('hex') }));
    return { checked: true, at, nodes: all.length, claims };
  } catch {
    return { checked: false, at, nodes: 0, claims: [] };
  }
}

export const privateState = unstable_cache(read, ['private-v1'], { revalidate: 600 });
