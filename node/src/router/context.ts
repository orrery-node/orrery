// The context a node lists, against the prompt a request carries. A node's model server refuses a prompt longer than
// it serves, and the refusal counts against the node in this router's own record, so a router that can see a prompt is
// clearly too long for a node sends it to one that lists enough. The prompt's length here is a floor, not an estimate.

/** At least how many tokens of text a request carries: its message text (string content and text parts) or its
 * embedding input, at five characters a token, coarser than tokenizers split ordinary text (about four). Images, audio,
 * tool definitions and JSON punctuation are left out, so this never counts more than the prompt holds. */
export function textTokensAtLeast(body: unknown): number {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  let chars = 0;
  const add = (s: unknown) => { if (typeof s === 'string') chars += s.length; };
  if (Array.isArray(b.messages)) {
    for (const m of b.messages as { content?: unknown }[]) {
      if (typeof m?.content === 'string') add(m.content);
      else if (Array.isArray(m?.content)) for (const p of m.content as { type?: unknown; text?: unknown }[]) if (p?.type === 'text') add(p.text);
    }
  }
  if (typeof b.input === 'string') add(b.input);
  else if (Array.isArray(b.input)) for (const s of b.input) add(s);
  return Math.floor(chars / 5);
}

/** The offers whose listed context the prompt is not clearly beyond, when at least one is; otherwise all of them, so
 * nothing is refused on a count: the model server decides, as before. */
export function fitting<T extends { offer: { context: number } }>(body: unknown, offers: T[]): T[] {
  const at = textTokensAtLeast(body);
  const fit = offers.filter((o) => !(o.offer.context > 0) || at <= o.offer.context);
  return fit.length ? fit : offers;
}
