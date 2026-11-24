/** The commands this CLI has, so a mistyped one is answered with the nearest instead of the whole help. */
export const COMMANDS = ['router', 'mcp', 'connect', 'run', 'bench', 'spend', 'sealed', 'doctor', 'peers', 'models', 'wallet', 'quote', 'enclave', 'providers', 'channels', 'close', 'provider', 'help', 'version'];
export const PROVIDER_COMMANDS = ['init', 'burn', 'check', 'start', 'compose', 'console', 'status', 'register', 'attest', 'redeem', 'earnings', 'vouchers', 'payouts', 'price', 'compare', 'show'];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The known word nearest to what was typed, when it is close enough to be a typo (two edits, one for short words). */
export function nearest(typed: string, known: string[]): string | null {
  const t = typed.toLowerCase();
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const dd = distance(t, k);
    if (dd < bestD) [best, bestD] = [k, dd];
  }
  return best !== null && bestD <= (t.length <= 4 ? 1 : 2) ? best : null;
}

/** What to say for a command this CLI does not have. */
export function unknownCommand(typed: string, cli: string, under?: 'provider'): string {
  const known = under ? PROVIDER_COMMANDS : COMMANDS;
  const near = nearest(typed, known);
  const name = under ? `${cli} provider ${typed}` : `${cli} ${typed}`;
  return `there is no ${name}.${near ? ` Did you mean ${under ? `${cli} provider ${near}` : `${cli} ${near}`}?` : ''} ${cli} --help lists every command`;
}
