// `orrery connect <client>`: the settings a client needs to send its requests through your router. The router has no
// API key (the wallet is the account), so clients that insist on one can be given any value.
import { CLI } from './brand.ts';

export const CLIENTS = ['codex', 'claude', 'opencode', 'aider', 'openai', 'anthropic', 'mcp'] as const;
/** The model the settings name when none is asked for. */
export const USUAL_MODEL = 'gpt-oss-120b';
export type Client = (typeof CLIENTS)[number];

/** A Codex CLI profile file ($CODEX_HOME/orrery.config.toml, used with `codex --profile orrery`). It sits beside the
 * user's config.toml and leaves it untouched. */
export function codexProfile(router: string, model: string, contextWindow?: number, agent: string | null = null): string {
  return [
    `model = "${model}"`,
    'model_provider = "orrery"',
    ...(contextWindow && contextWindow > 0 ? [`model_context_window = ${Math.floor(contextWindow)}`] : []),
    '',
    '[model_providers.orrery]',
    'name = "Orrery"',
    `base_url = "${router.replace(/\/$/, '')}/v1"`,
    'wire_api = "responses"',
    ...(agent ? [`http_headers = { "x-orrery-agent" = "${agent}" }`] : []),
    '',
  ].join('\n');
}

/** An opencode config (opencode.jsonc) with the router as an OpenAI-compatible provider named orrery, and the model as
 * the one it starts on. With an agent, every request carries the agent header. No key: the router has none. */
export function opencodeConfig(router: string, model: string, agent: string | null = null): string {
  return JSON.stringify({
    model: `orrery/${model}`,
    providers: {
      orrery: {
        name: 'Orrery',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${router.replace(/\/$/, '')}/v1` },
        ...(agent ? { headers: { 'x-orrery-agent': agent } } : {}),
        models: { [model]: { name: `${model} on Orrery` } },
      },
    },
  }, null, 2);
}

/** What to set for a client, as text to print. With an agent, every request the client sends is made as that agent,
 * held to the limit the router gives it with --agent-cap: a header where the client can send one, else the key
 * agent/<name>, which the router reads the same way. */
export function instructions(client: Client, router: string, model: string, codexProfilePath: string, agent: string | null = null): string {
  const base = router.replace(/\/$/, '');
  const key = agent ? `agent/${agent}` : 'orrery';
  const keyNote = agent ? `# every request goes as agent ${agent}, held to the router's --agent-cap for it` : '# any value; the router has no key';
  const mcpAgent = agent ? ` --agent ${agent}` : '';
  switch (client) {
    case 'codex':
      return `Save as ${codexProfilePath} (or run ${CLI} connect codex --write${mcpAgent}):\n\n${codexProfile(base, model, undefined, agent)}\nThen: codex --profile orrery`;
    case 'claude':
      return `ANTHROPIC_BASE_URL=${base} ANTHROPIC_API_KEY=${key} claude\nRun the router with --alias 'claude-*=${model}' so Claude Code's model names are answered by ${model} on the network.${agent ? `\nEvery request goes as agent ${agent}, held to the router's --agent-cap for it.` : `\nOr let ${CLI} start it as one job with a budget and a bill at the end: ${CLI} run claude --budget 0.25`}`;
    case 'opencode':
      return `Save as opencode.jsonc in your project, or add its "orrery" provider to the config you have:\n\n${opencodeConfig(base, model, agent)}\n\nThen: opencode   (it starts on orrery/${model}; /models lists it)${agent ? `\nEvery request goes as agent ${agent}, held to the router's --agent-cap for it.` : ''}`;
    case 'aider':
      return `OPENAI_API_BASE=${base}/v1 OPENAI_API_KEY=${key} aider --model openai/${model}\n${keyNote}`;
    case 'openai':
      return `OPENAI_BASE_URL=${base}/v1\nOPENAI_API_KEY=${key}   ${keyNote}\nmodel: ${model}   (Chat Completions and Responses both work)`;
    case 'anthropic':
      return `ANTHROPIC_BASE_URL=${base}\nANTHROPIC_API_KEY=${key}   ${keyNote}\nmodel: ${model}   (or run the router with --alias 'claude-*=${model}')`;
    case 'mcp':
      return `Command for an MCP client: npx -y orrery-node mcp --router ${base}${mcpAgent}\nClaude Code: claude mcp add orrery -- npx -y orrery-node mcp --router ${base}${mcpAgent}`;
  }
}

/** How to start a router, for someone who has none running: with a wallet it is one command, without one the wallet
 * comes first. */
export const startRouter = (hasWallet: boolean, cli = CLI) => (hasWallet ? `${cli} router` : `${cli} wallet new   (makes the wallet that pays; send it SOL and USDC), then ${cli} router`);

/** What `orrery connect` adds when the router it points at would not serve the settings it just printed: nothing
 * answers there, the router has found no node, or the model is not listed. Null when the settings work as printed.
 * `models` is what the router lists (null when nothing answers); `asked` is whether the model came from --model. */
export function routerNote(o: { client: Client; router: string; models: { id?: string }[] | null; model: string; asked: boolean; hasWallet: boolean }, cli = CLI): string | null {
  const base = o.router.replace(/\/$/, '');
  if (!o.models) return `note: no router answers at ${base} yet, so nothing will connect with these settings. Start one first: ${startRouter(o.hasWallet, cli)}`;
  const listed = o.models.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!listed.length) return `note: your router answers at ${base} but lists no model yet: it has found no node that answers. ${cli} doctor shows what it sees.`;
  if (o.client === 'mcp') return null; // an MCP client picks its model per request, from the router's own list
  if (!listed.includes(o.model)) return `note: your router does not list ${o.model} right now, so requests for it will not be answered. It lists: ${listed.slice(0, 6).join(', ')}${listed.length > 6 ? ` and ${listed.length - 6} more` : ''}`;
  if (!o.asked && o.model !== USUAL_MODEL) return `note: ${USUAL_MODEL} is not on the network right now, so these settings name ${o.model}, which your router lists.`;
  return null;
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
