// `orrery provider init`: finds an OpenAI-compatible model server on this machine, lists its models and writes a starting
// provider.json, so selling inference starts from a file that already points at the right upstream.
import { PROVIDER_PORT, USDC_MAINNET } from '../brand.ts';

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Where the common local servers listen by default. */
export const KNOWN_UPSTREAMS: [string, string][] = [
  ['Ollama', 'http://127.0.0.1:11434/v1'],
  ['vLLM', 'http://127.0.0.1:8000/v1'],
  ['llama.cpp', 'http://127.0.0.1:8080/v1'],
  ['LM Studio', 'http://127.0.0.1:1234/v1'],
  ['SGLang', 'http://127.0.0.1:30000/v1'],
];

export type Found = { name: string; baseUrl: string; models: string[] };

/** The first server that answers /models with at least one model: the one given, or the known local ones in order. */
export async function findUpstream(explicit: string | undefined, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Found> {
  const tries: [string, string][] = explicit ? [['your server', explicit.replace(/\/$/, '')]] : KNOWN_UPSTREAMS;
  for (const [name, baseUrl] of tries) {
    try {
      const r = await fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(1_500) });
      if (!r.ok) continue;
      const j = (await r.json()) as { data?: { id?: string }[] };
      const models = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (models.length) return { name, baseUrl, models };
    } catch {
      continue;
    }
  }
  throw new Error(explicit ? `no models at ${explicit}/models` : `no OpenAI-compatible server answered on ${KNOWN_UPSTREAMS.map(([n, u]) => `${n} (${u})`).join(', ')}; pass --upstream <url>`);
}

/** A network-style model id from an upstream one: llama3.1:8b → llama3.1-8b, Qwen/Qwen3-32B → qwen3-32b. */
export const networkId = (upstream: string) => upstream.split('/').pop()!.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

/** A starting provider config: every model the server lists, at a placeholder price to edit. */
export function draftConfig(found: Found, o: { name?: string; publicUrl?: string; wallet?: string } = {}) {
  return {
    name: o.name ?? 'My Orrery node',
    listen: PROVIDER_PORT,
    publicUrl: o.publicUrl ?? 'https://your-node.example.com',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    settleMint: USDC_MAINNET,
    wallet: o.wallet ?? '~/.config/solana/id.json',
    dataDir: '~/.orrery/provider',
    upstream: { baseUrl: found.baseUrl },
    models: found.models.map((id) => ({ id: networkId(id), upstreamModel: id, context: 32_768, maxOutput: 4_096, price: { input: 500_000, output: 1_000_000 } })),
    redeem: { everySecs: 300, minUnits: 1_000 },
  };
}
