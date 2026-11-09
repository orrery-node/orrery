// Server only. Every model price listed on the network, read the way a router reads it: each provider account on
// Solana, its price list fetched from the node and checked against the hash on chain. Cached for five minutes.
import { unstable_cache } from 'next/cache';
import { Connection } from '@solana/web3.js';

export type Listing = { provider: string; address: string; model: string; input: number; output: number; cachedInput: number | null; context: number; enclave: boolean };
export type Prices = { checked: boolean; at: string; listings: Listing[] };

type Entry = { address: string; manifest: { name: string; models: { id: string; context: number; price: { input: number; output: number; cachedInput?: number } }[] } | null; tee: { verified: boolean } | null };

async function read(): Promise<Prices> {
  const at = new Date().toISOString();
  const url = process.env.SOLANA_RPC_URL;
  if (!url) return { checked: false, at, listings: [] };
  try {
    const { Registry } = (await import('orrery-node/dist/router/registry.js')) as unknown as {
      Registry: new (c: Connection, o: { allowDev: boolean; measurements: string[] }) => { refresh(): Promise<void>; usable(): Entry[] };
    };
    const registry = new Registry(new Connection(url, 'confirmed'), { allowDev: false, measurements: [] });
    await registry.refresh();
    const listings: Listing[] = [];
    for (const e of registry.usable()) {
      for (const m of e.manifest?.models ?? []) {
        listings.push({
          provider: e.manifest!.name, address: e.address, model: m.id, input: m.price.input, output: m.price.output,
          cachedInput: m.price.cachedInput ?? null, context: m.context, enclave: !!e.tee?.verified,
        });
      }
    }
    return { checked: true, at, listings };
  } catch {
    return { checked: false, at, listings: [] };
  }
}

export const prices = unstable_cache(read, ['prices-v1'], { revalidate: 300 });
