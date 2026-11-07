// `orrery connect <client>`: the settings a client needs to send its requests through your router. The router has no
// API key (the wallet is the account), so clients that insist on one can be given any value.
import { CLI } from './brand.ts';

export const CLIENTS = ['codex', 'openai', 'anthropic', 'mcp'] as const;
export type Client = (typeof CLIENTS)[number];

/** A Codex CLI profile file ($CODEX_HOME/orrery.config.toml, used with `codex --profile orrery`). It sits beside the
 * user's config.toml and leaves it untouched. */
export function codexProfile(router: string, model: string): string {
  return [
    `model = "${model}"`,
    'model_provider = "orrery"',
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
    case 'openai':
      return `OPENAI_BASE_URL=${base}/v1\nOPENAI_API_KEY=orrery   # any value; the router has no key\nmodel: ${model}   (Chat Completions and Responses both work)`;
    case 'anthropic':
      return `ANTHROPIC_BASE_URL=${base}\nANTHROPIC_API_KEY=orrery   # any value; the router has no key\nmodel: ${model}   (or run the router with --alias 'claude-*=${model}')`;
    case 'mcp':
      return `Command for an MCP client: npx -y orrery-node mcp --router ${base}\nClaude Code: claude mcp add orrery -- npx -y orrery-node mcp --router ${base}`;
  }
}
