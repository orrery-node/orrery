// `orrery provider init`: finds an OpenAI-compatible model server on this machine, lists its models and writes a starting
// provider.json, so selling inference starts from a file that already points at the right upstream.
import { privateAddress } from '../address.ts';
import { PROVIDER_PORT, TICKER, USDC_MAINNET } from '../brand.ts';
import type { HolderTier } from '../holder.ts';

/** The holder tiers a new node starts with: the seed node's own (0.1% of the network token's supply for 20% less, 1%
 * for 35% less), so a holder's price means the same at every node that keeps them. */
export const DEFAULT_HOLDER_TIERS: HolderTier[] = [{ share: 10, off: 2_000 }, { share: 100, off: 3_500 }];

/** What provider init says about the holder prices it wrote:
 *   holder prices: $OREY holders pay 20% less with 0.1% of its supply, 35% less with 1% (the seed node's tiers) */
export function holderTiersNote(tiers: HolderTier[]): string {
  const pct = (bp: number) => `${bp / 100}%`;
  return `holder prices: $${TICKER} holders pay ${tiers.map((t, i) => `${pct(t.off)} less with ${pct(t.share)}${i === 0 ? ' of its supply' : ''}`).join(', ')}`;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Where the common local servers listen by default. */
export const KNOWN_UPSTREAMS: [string, string][] = [
  ['Ollama', 'http://127.0.0.1:11434/v1'],
  ['vLLM', 'http://127.0.0.1:8000/v1'],
  ['llama.cpp', 'http://127.0.0.1:8080/v1'],
  ['LM Studio', 'http://127.0.0.1:1234/v1'],
  ['SGLang', 'http://127.0.0.1:30000/v1'],
];

/** `contexts`: the tokens of context the server says it serves each model with, where it says (vLLM and SGLang list
 * max_model_len in /models; Ollama and LM Studio do not). */
export type Found = { name: string; baseUrl: string; models: string[]; contexts?: Record<string, number> };

/** Ollama does not say in /models how much context it serves, and reads only as much of a prompt as its own setting
 * allows, dropping the rest without an error. A listing it can always read whole, until the operator raises both. */
export const OLLAMA_CONTEXT = 4_096;
export const OLLAMA_NOTE = `Ollama reads only as much of a prompt as its own context setting allows (OLLAMA_CONTEXT_LENGTH when it starts) and drops the rest without an error, so provider.json lists ${OLLAMA_CONTEXT.toLocaleString('en-US')} tokens to stay within it. Start Ollama with more and raise "context" to match, with "maxOutput" at a quarter of it`;

/** A server given with --upstream that is Ollama: it lists each model's namespace as owned_by ("library" for its
 * own models), or it listens on Ollama's port. */
const looksLikeOllama = (baseUrl: string, data: { owned_by?: unknown }[]) => data.some((m) => m.owned_by === 'library') || /:11434(\/|$)/.test(baseUrl);

/** The context a /models entry says its model is served with, or null when it does not say. */
export const servedContext = (m: { max_model_len?: unknown }): number | null =>
  typeof m.max_model_len === 'number' && Number.isSafeInteger(m.max_model_len) && m.max_model_len > 0 ? m.max_model_len : null;

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
      const j = (await r.json()) as { data?: { id?: string; max_model_len?: unknown; owned_by?: unknown }[] };
      const listed = (j.data ?? []).filter((m): m is { id: string; max_model_len?: unknown } => typeof m.id === 'string' && m.id.length > 0);
      const models = listed.map((m) => m.id);
      const contexts = Object.fromEntries(listed.flatMap((m) => { const c = servedContext(m); return c ? [[m.id, c]] : []; }));
      if (models.length) return { name: explicit && looksLikeOllama(baseUrl, j.data ?? []) ? 'Ollama' : name, baseUrl, models, ...(Object.keys(contexts).length ? { contexts } : {}) };
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
export function nextSteps(out: string, cli = 'orrery', o: { publicUrl?: string; localCluster?: boolean } = {}): string {
  // An address given to init is not asked for again; the placeholder still is, and so is one only the operator's own
  // network reaches on a public cluster (register refuses it without --private-address).
  const addressSet = !!o.publicUrl && !/^https?:\/\/your-node\.example\.com\/?$/.test(o.publicUrl);
  const unreachable = addressSet && !o.localCluster && privateAddress(o.publicUrl!);
  return [
    unreachable
      ? `  1. set publicUrl to a public domain or IP with this node’s port open: ${o.publicUrl} reaches only machines on your own network (step 3 with --private-address lists it there alone), and check your prices (micro-USDC per million tokens; 500000 = $0.50)`
      : addressSet
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

/** Rerankers by their usual names (bge-reranker-v2-m3, mxbai-rerank-large, jina-reranker-v2): priced on input tokens
 * only and listed with "kind": "rerank", so routers send them /v1/rerank. Checked before embeddings, whose names they
 * share (bge, mxbai, jina). */
export const isRerankModel = (id: string) => /(^|[/_.-])re-?rank/i.test(id);

/** Text-to-speech models by their usual names (Kokoro, Piper, Orpheus, Chatterbox, or anything called TTS): listed with
 * "kind": "speech" and billed on the text they are given, one input token per 4 characters. */
export const isSpeechModel = (id: string) => !isRerankModel(id) && /(kokoro|piper|orpheus|chatterbox|tts)/i.test(id);

/** Embedding models by their usual names; they are priced on input tokens only and listed with "kind": "embeddings". */
export const isEmbeddingModel = (id: string) => !isRerankModel(id) && /(^|[/_.-])(embed|embedding|bge|e5|gte|nomic-embed|mxbai|arctic-embed|jina-embeddings)/i.test(id);

/** A network-style model id from an upstream one: llama3.1:8b → llama3.1-8b, Qwen/Qwen3-32B → qwen3-32b. */
export const networkId = (upstream: string) => upstream.split('/').pop()!.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');

/** A starting provider config: every model the server lists, at a placeholder price to edit. A server that can report
 * cache hits also gets a cached-input price, a quarter of the input price, which applies only to the hits it reports.
 * Embedding models are priced on input tokens only ($0.02 per million to start). A new node lists payment inside the
 * seal in its price list from its first registration, so routers keep to it from their first request (README). */
export function draftConfig(found: Found, o: { name?: string; publicUrl?: string; wallet?: string; rpcUrl?: string; notify?: { url: string } | { urlEnv: string }; holderPrices?: boolean } = {}) {
  return {
    name: o.name ?? 'My Orrery node',
    listen: PROVIDER_PORT,
    publicUrl: o.publicUrl ?? 'https://your-node.example.com',
    rpcUrl: o.rpcUrl ?? 'https://api.mainnet-beta.solana.com',
    settleMint: USDC_MAINNET,
    wallet: o.wallet ?? SOLANA_WALLET,
    dataDir: '~/.orrery/provider',
    upstream: { baseUrl: found.baseUrl },
    // The context the server says it serves, where it says: a router's clients size their prompts to the listed
    // number, and a longer one fails at the server. A quarter of it is kept for the answer, up to 4,096 tokens.
    models: found.models.map((id): { id: string; upstreamModel: string; context: number; maxOutput: number; price: { input: number; output: number; cachedInput?: number }; kind?: 'embeddings' | 'rerank' | 'speech' } => {
      const served = found.contexts?.[id] ?? (found.name === 'Ollama' && !isEmbeddingModel(id) && !isRerankModel(id) && !isSpeechModel(id) ? OLLAMA_CONTEXT : undefined);
      if (isRerankModel(id)) return { id: networkId(id), upstreamModel: id, context: served ?? 8_192, maxOutput: 1, price: { input: 20_000, output: 0 }, kind: 'rerank' as const };
      if (isSpeechModel(id)) return { id: networkId(id), upstreamModel: id, context: served ?? 4_096, maxOutput: 1, price: { input: 2_000_000, output: 0 }, kind: 'speech' as const };
      return isEmbeddingModel(id)
        ? { id: networkId(id), upstreamModel: id, context: served ?? 8_192, maxOutput: 1, price: { input: 20_000, output: 0 }, kind: 'embeddings' as const }
        : { id: networkId(id), upstreamModel: id, context: served ?? 32_768, maxOutput: served ? Math.max(1, Math.min(4_096, Math.floor(served / 4))) : 4_096, price: { input: 500_000, output: 1_000_000, ...(CACHE_REPORTING[found.name] ? { cachedInput: 125_000 } : {}) } };
    }),
    redeem: { everySecs: 300, minUnits: 50_000 },
    paymentInside: true,
    // Holder prices are on unless the operator says otherwise (--no-holder-prices): the seed node's tiers.
    ...(o.holderPrices === false ? {} : { holder: { tiers: DEFAULT_HOLDER_TIERS.map((t) => ({ ...t })) } }),
    // The webhook each payout's arrival (and the day's books) is posted to, when init was given one.
    ...(o.notify ? { notify: o.notify } : {}),
  };
}
