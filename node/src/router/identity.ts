// Who is asking stays on this machine. Clients attach ids to their requests (OpenAI `user` and `safety_identifier`,
// Anthropic `metadata.user_id`, which Claude Code fills with an account, device and session id), meant for the API
// company's own abuse checks. Here the wallet is the account and a node is paid either way, so a node has no use for
// them, and neither does whatever model server it runs. The router drops them before a request leaves.
export const IDENTITY_FIELDS = ['user', 'metadata', 'safety_identifier', 'prompt_cache_key'] as const;

/** The request without the fields that say who the end user is. The prompt itself is untouched. */
export function withoutIdentity<T extends Record<string, unknown>>(body: T): T {
  const out: Record<string, unknown> = { ...body };
  for (const k of IDENTITY_FIELDS) delete out[k];
  return out as T;
}
