// Nodes naming other nodes: the listings a node's operator vouches for (--knows), served at /orrery/known. A router that
// reads them checks each on chain by address, so a node can point at listings and never make one up.

/** How many listings a node names, and how many a router takes from one node. */
export const KNOWN_MAX = 100;
const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** What a node serves at /orrery/known: the listings it was given, each once, well-formed, never its own, at most KNOWN_MAX. */
export function knownList(given: string[] | undefined, own: string): string[] {
  return [...new Set((given ?? []).map((a) => a.trim()))].filter((a) => base58.test(a) && a !== own).slice(0, KNOWN_MAX);
}

/** The node console's and `orrery provider status`'s sentence on what this node names at /orrery/known; nothing when it
 * names none. Self-contained: the console page inlines it. */
export function knowsSentence(k: { count: number; file: string | null } | null | undefined): string {
  if (!k || !k.count) return '';
  return 'Names ' + k.count + ' other node' + (k.count === 1 ? '' : 's') + ' at /orrery/known' + (k.file ? ' (--knows and ' + k.file + ', read again at every request)' : '') + ': routers that read this node check each on chain and add it to their map.';
}

/** A --knows-file read: one listing a line, anything after # a note for the operator, blank lines skipped. */
export function knowsFileLines(text: string): string[] {
  return text.split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean);
}

/** A node's /orrery/known answer, read as data: the well-formed addresses in it, at most KNOWN_MAX; anything else is none. */
export function readKnown(j: unknown): string[] {
  const k = (j as { known?: unknown } | null)?.known;
  if (!Array.isArray(k)) return [];
  return [...new Set(k.filter((a): a is string => typeof a === 'string' && base58.test(a)))].slice(0, KNOWN_MAX);
}
