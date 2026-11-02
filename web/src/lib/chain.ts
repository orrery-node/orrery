// Server only. Reads Solana mainnet through the site's own RPC (SOLANA_RPC_URL, never sent to the browser).
// The page revalidates every five minutes, so this runs at most once per five minutes per region.
import { unstable_cache } from 'next/cache';
import { PROGRAM_ID } from '@/brand';

export type ProgramStatus = { checked: boolean; deployed: boolean; at: string };

async function read(): Promise<ProgramStatus> {
  const at = new Date().toISOString();
  const url = process.env.SOLANA_RPC_URL;
  if (!url) return { checked: false, deployed: false, at };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [PROGRAM_ID, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { checked: false, deployed: false, at };
    const body = (await res.json()) as { result?: { value?: { executable?: boolean } | null } };
    if (!body.result) return { checked: false, deployed: false, at };
    return { checked: true, deployed: !!body.result.value?.executable, at };
  } catch {
    return { checked: false, deployed: false, at };
  }
}

export const programStatus = unstable_cache(read, ['program-status'], { revalidate: 300 });
