// `orrery connect <client>`: the settings a client needs to send its requests through your router. The router has no
// API key (the wallet is the account), so clients that insist on one can be given any value.
import { CLI } from './brand.ts';

export const CLIENTS = ['codex', 'claude', 'openai', 'anthropic', 'mcp'] as const;
export type Client = (typeof CLIENTS)[number];

/** A Codex CLI profile file ($CODEX_HOME/orrery.config.toml, used with `codex --profile orrery`). It sits beside the
 * user's config.toml and leaves it untouched. */
export function codexProfile(router: string, model: string, contextWindow?: number): string {
  return [
    `model = "${model}"`,
    'model_provider = "orrery"',
    ...(contextWindow && contextWindow > 0 ? [`model_context_window = ${Math.floor(contextWindow)}`] : []),
    '',
    '[model_providers.orrery]',
    'name = "Orrery"',
    `base_url = "${router.replace(/\/$/, '')}/v1"`,
    'wire_api = "responses"',
    '',
  ].join('\n');
}

/** What to set for a client, as text to print. */
export function instructions(client: Client, router: string, model: string, codexProfilePath: string): string {
  const base = router.replace(/\/$/, '');
  switch (client) {
    case 'codex':
      return `Save as ${codexProfilePath} (or run ${CLI} connect codex --write):\n\n${codexProfile(base, model)}\nThen: codex --profile orrery`;
    case 'claude':
      return `ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=orrery claude\nRun the router with --alias 'claude-*=${model}' so Claude Code's model names are answered by ${model} on the network.`;
    case 'openai':
      return `OPENAI_BASE_URL=${base}/v1\nOPENAI_API_KEY=orrery   # any value; the router has no key\nmodel: ${model}   (Chat Completions and Responses both work)`;
    case 'anthropic':
      return `ANTHROPIC_BASE_URL=${base}\nANTHROPIC_API_KEY=orrery   # any value; the router has no key\nmodel: ${model}   (or run the router with --alias 'claude-*=${model}')`;
    case 'mcp':
      return `Command for an MCP client: npx -y orrery-node mcp --router ${base}\nClaude Code: claude mcp add orrery -- npx -y orrery-node mcp --router ${base}`;
  }
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** The model's context length as the running router lists it (from the providers' manifests), if the router is up. */
export async function contextFromRouter(router: string, model: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<number | undefined> {
  try {
    const r = await fetchFn(`${router.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(1_500) });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { data?: { id?: string; context_length?: number }[] };
    const m = (j.data ?? []).find((x) => x.id === model);
    return typeof m?.context_length === 'number' && m.context_length > 0 ? m.context_length : undefined;
  } catch {
    return undefined;
  }
}
