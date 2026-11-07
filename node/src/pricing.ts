// Prices are USDC base units (6 decimals) per million tokens, so $0.60 per million is 600_000. Both sides compute
// a request's cost with the same integer formula, rounded up to the next base unit.
// A provider may also list cachedInput: the price of input tokens its model server served from a prompt cache (the long
// prefix a coding agent resends every turn). It can only be at or below the input price.
export type Price = { input: number; output: number; cachedInput?: number };

const MILLION = 1_000_000n;
const whole = (n: number) => BigInt(Math.max(0, Math.floor(n)));

export function costOf(p: Price, inputTokens: number, outputTokens: number, cachedTokens = 0): bigint {
  const input = whole(inputTokens);
  const cached = p.cachedInput === undefined ? 0n : whole(Math.min(cachedTokens, inputTokens));
  const raw = (input - cached) * BigInt(p.input) + cached * BigInt(p.cachedInput ?? p.input) + whole(outputTokens) * BigInt(p.output);
  return (raw + MILLION - 1n) / MILLION;
}

/** A rough upper bound for a request's prompt before it runs: 4 characters per token over everything the model
 * reads (messages, tool definitions, response schema). Router and provider compute it the same way. */
export function estimateInputTokens(body: unknown): number {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const read = b && ('messages' in b || 'tools' in b) ? { m: b.messages, t: b.tools, r: b.response_format } : body;
  return Math.ceil(JSON.stringify(read ?? '').length / 4);
}

export function usd(units: bigint, digits = 6): string {
  const neg = units < 0n;
  const v = neg ? -units : units;
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').slice(0, digits);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function perMillion(units: number): string {
  return `$${(units / 1_000_000).toFixed(units < 100_000 ? 3 : 2)}/M`;
}
