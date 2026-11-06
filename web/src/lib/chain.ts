// Server only. Reads Solana mainnet through the site's own RPC (SOLANA_RPC_URL, never sent to the browser).
// The page revalidates every five minutes, so this runs at most once per five minutes per region.
import { createHash } from 'node:crypto';
import { unstable_cache } from 'next/cache';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID } from '@/brand';

export type ProgramStatus = { checked: boolean; deployed: boolean; at: string };

export type Mainnet = {
  checked: boolean;
  at: string;
  deployed: boolean;
  providers: number;
  channels: number;
  settledUnits: string;
  programHash: string | null;
  verified: boolean | null;
};

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { result?: T };
  return body.result ?? null;
}

async function account(address: string): Promise<{ data: Buffer; executable: boolean } | null> {
  const r = await rpc<{ value: { data: [string, string]; executable: boolean } | null }>('getAccountInfo', [address, { encoding: 'base64' }]);
  if (!r?.value) return null;
  return { data: Buffer.from(r.value.data[0], 'base64'), executable: r.value.executable };
}

async function read(): Promise<ProgramStatus> {
  const at = new Date().toISOString();
  if (!process.env.SOLANA_RPC_URL) return { checked: false, deployed: false, at };
  try {
    const r = await rpc<{ value: { executable?: boolean } | null }>('getAccountInfo', [PROGRAM_ID, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    if (!r) return { checked: false, deployed: false, at };
    return { checked: true, deployed: !!r.value?.executable, at };
  } catch {
    return { checked: false, deployed: false, at };
  }
}

/** Live numbers from the program's Config account, plus the sha-256 of the deployed bytes (the hash
 * `solana-verify get-program-hash` prints) and the public verifier's verdict. */
async function readMainnet(): Promise<Mainnet> {
  const at = new Date().toISOString();
  const empty: Mainnet = { checked: false, at, deployed: false, providers: 0, channels: 0, settledUnits: '0', programHash: null, verified: null };
  if (!process.env.SOLANA_RPC_URL) return empty;
  try {
    const program = new PublicKey(PROGRAM_ID);
    const config = PublicKey.findProgramAddressSync([Buffer.from('config')], program)[0];
    const programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
    const [cfg, pd] = await Promise.all([account(config.toBase58()), account(programData.toBase58())]);
    let programHash: string | null = null;
    if (pd && pd.data.length > 45) {
      let end = pd.data.length;
      while (end > 45 && pd.data[end - 1] === 0) end--;
      programHash = createHash('sha256').update(pd.data.subarray(45, end)).digest('hex');
    }
    const verified = await fetch(`https://verify.osec.io/status/${PROGRAM_ID}`, { signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { is_verified?: boolean } | null) => (typeof j?.is_verified === 'boolean' ? j.is_verified : null))
      .catch(() => null);
    if (!cfg || cfg.data.length < 184) return { ...empty, checked: true, deployed: !!pd, programHash, verified };
    return {
      checked: true,
      at,
      deployed: true,
      providers: Number(cfg.data.readBigUInt64LE(160)),
      channels: Number(cfg.data.readBigUInt64LE(168)),
      settledUnits: cfg.data.readBigUInt64LE(176).toString(),
      programHash,
      verified,
    };
  } catch {
    return empty;
  }
}

export const programStatus = unstable_cache(read, ['program-status'], { revalidate: 300 });
export const mainnet = unstable_cache(readMainnet, ['mainnet-v1'], { revalidate: 300 });
