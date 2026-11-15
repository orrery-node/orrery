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

/** The command that gives a fresh Ollama its first model, for the messages that point a new operator at one. */
const FIRST_MODEL = 'ollama pull llama3.1:8b';

/** Servers that can report prompt-cache hits in usage.prompt_tokens_details.cached_tokens, and the flag that turns it on. */
export const CACHE_REPORTING: Record<string, string> = {
  vLLM: '--enable-prompt-tokens-details',
  SGLang: '--enable-cache-report',
};

/** The first server that answers /models with at least one model: the one given, or the known local ones in order. */
export async function findUpstream(explicit: string | undefined, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Found> {
  const tries: [string, string][] = explicit ? [['your server', explicit.replace(/\/$/, '')]] : KNOWN_UPSTREAMS;
  // A server that answers with no models yet (a fresh Ollama) is remembered: that is a different next step from no
  // server at all.
  let empty: [string, string] | null = null;
  for (const [name, baseUrl] of tries) {
    try {
      const r = await fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(1_500) });
      if (!r.ok) continue;
      const j = (await r.json()) as { data?: { id?: string }[] };
      const models = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (models.length) return { name, baseUrl, models };
      empty ??= [name, baseUrl];
    } catch {
      continue;
    }
  }
  if (empty) throw new Error(`${empty[0]} answered at ${empty[1]} but has no models yet. ${empty[0] === 'Ollama' ? `Pull one (${FIRST_MODEL})` : 'Load one in it'} and run this again`);
  throw new Error(explicit
    ? `no model server answered at ${explicit}/models`
    : `no model server answered on this computer (looked for ${KNOWN_UPSTREAMS.map(([n, u]) => `${n} at ${u.replace(/^http:\/\/127\.0\.0\.1/, '')}`).join(', ')}). Start one and run this again: the quickest is Ollama (ollama serve, then ${FIRST_MODEL}). For a server somewhere else, pass --upstream <url>`);
}

/** What is left to do after `provider init` wrote a config, in order. */
export function nextSteps(out: string, cli = 'orrery', o: { publicUrl?: string } = {}): string {
  // An address given to init is not asked for again; the placeholder still is.
  const addressSet = !!o.publicUrl && !/^https?:\/\/your-node\.example\.com\/?$/.test(o.publicUrl);
  return [
    addressSet
      ? `  1. check your prices in ${out} (micro-USDC per million tokens; 500000 = $0.50); routers will reach the node at ${o.publicUrl}`
      : `  1. set publicUrl to an address routers can reach, and your prices (micro-USDC per million tokens; 500000 = $0.50)`,
    `  2. ${cli} provider compare --config ${out} to see where new prices would stand`,
    `  3. ${cli} provider register --config ${out} lists the node on chain (one transaction from the wallet named in ${out})`,
    `  4. ${cli} provider check --config ${out} says whether it is ready to earn`,
    `  5. ${cli} provider start --config ${out}, or ${cli} provider compose --config ${out} to run it in Docker`,
  ].join('\n');
}

/** Where the Solana tools keep a wallet. */
export const SOLANA_WALLET = '~/.config/solana/id.json';

/** The wallet file a draft names: the one asked for, else the one `orrery wallet new` made in the home folder, else
 * the usual Solana file when it is there, else the home folder's place, where `orrery wallet new` will put one. */
export function draftWallet(o: { asked?: string; home: string; homeExists: boolean; solanaExists: boolean }): string {
  if (o.asked) return o.asked;
  if (o.homeExists) return o.home;
  return o.solanaExists ? SOLANA_WALLET : o.home;
}

/** What `provider init` says about the wallet its draft names: the address the node will be listed under, or, when
 * the file is not there, how to get one. Saying it now beats an error at the next command. */
export function walletNote(o: { wallet: string; exists: boolean; isHome: boolean; out: string; address?: string }, cli = 'orrery'): string {
  if (o.exists) return `the node will be listed under ${o.address ? `${o.address}, the wallet at ${o.wallet}` : `the wallet at ${o.wallet}`}. It signs once, for provider register.`;
  return `note: there is no wallet at ${o.wallet} yet. ${cli} wallet new${o.isHome ? '' : ` --out ${o.wallet}`} makes one there. Or point "wallet" in ${o.out} at a Solana wallet you have, or put its address in "authority".`;
}

/** Embedding models by their usual names; they are priced on input tokens only. */
export const isEmbeddingModel = (id: string) => /(^|[/_.-])(embed|embedding|bge|e5|gte|nomic-embed|mxbai|arctic-embed|jina-embeddings)/i.test(id);

/** A network-style model id from an upstream one: llama3.1:8b → llama3.1-8b, Qwen/Qwen3-32B → qwen3-32b. */
export const networkId = (upstream: string) => upstream.split('/').pop()!.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

/** A starting provider config: every model the server lists, at a placeholder price to edit. A server that can report
 * cache hits also gets a cached-input price, a quarter of the input price, which applies only to the hits it reports.
 * Embedding models are priced on input tokens only ($0.02 per million to start). A new node lists payment inside the
 * seal in its price list from its first registration, so routers keep to it from their first request (README). */
export function draftConfig(found: Found, o: { name?: string; publicUrl?: string; wallet?: string } = {}) {
  return {
    name: o.name ?? 'My Orrery node',
    listen: PROVIDER_PORT,
    publicUrl: o.publicUrl ?? 'https://your-node.example.com',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    settleMint: USDC_MAINNET,
    wallet: o.wallet ?? SOLANA_WALLET,
    dataDir: '~/.orrery/provider',
    upstream: { baseUrl: found.baseUrl },
    models: found.models.map((id) => (isEmbeddingModel(id) ? { id: networkId(id), upstreamModel: id, context: 8_192, maxOutput: 1, price: { input: 20_000, output: 0 } } : { id: networkId(id), upstreamModel: id, context: 32_768, maxOutput: 4_096, price: { input: 500_000, output: 1_000_000, ...(CACHE_REPORTING[found.name] ? { cachedInput: 125_000 } : {}) } })),
    redeem: { everySecs: 300, minUnits: 50_000 },
    paymentInside: true,
  };
}
