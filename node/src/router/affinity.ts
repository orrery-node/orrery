// Prompt-cache affinity. An agent resends the same opening messages every turn, and a provider's prompt cache only
// pays off if the next turn goes back to that provider. The router remembers which provider last served each prefix,
// and ranking prices that provider's offer with the prefix as cached input, so a provider that lists a cached-input
// price keeps the session when the cache makes it the better deal.
import { createHash } from 'node:crypto';

export type Prefix = { key: string; tokens: number };
export type Sticky = { address: string; tokens: number };

/** One rolling key per prefix of the conversation (first message, first two, …, all of them), with its token estimate. */
export function prefixes(model: string, messages: unknown): Prefix[] {
  if (!Array.isArray(messages) || !messages.length) return [];
  const out: Prefix[] = [];
  let h = createHash('sha256').update(model).digest();
  let chars = 0;
  for (const m of messages) {
    const s = JSON.stringify(m);
    chars += s.length;
    h = createHash('sha256').update(h).update(s).digest();
    out.push({ key: h.toString('hex'), tokens: Math.ceil(chars / 4) });
  }
  return out;
}

export class Affinity {
  private m = new Map<string, { address: string; tokens: number; at: number }>();

  constructor(private ttlMs = 5 * 60_000, private max = 2_000) {}

  /** The provider that last served the longest of these prefixes, if it was recent enough to still be cached. */
  find(ps: Prefix[], now = Date.now()): Sticky | null {
    for (let i = ps.length - 1; i >= 0; i--) {
      const hit = this.m.get(ps[i].key);
      if (hit && now - hit.at <= this.ttlMs) return { address: hit.address, tokens: hit.tokens };
    }
    return null;
  }

  /** After a provider served a request: it now holds the whole prompt, and the opening message that other sessions share. */
  remember(ps: Prefix[], address: string, now = Date.now()) {
    if (!ps.length) return;
    for (const p of ps.length > 1 ? [ps[0], ps[ps.length - 1]] : [ps[0]]) {
      this.m.delete(p.key);
      this.m.set(p.key, { address, tokens: p.tokens, at: now });
    }
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
}
