// Prices are USDC base units (6 decimals) per million tokens, so $0.60 per million is 600_000. Both sides compute
// a request's cost with the same integer formula, rounded up to the next base unit.
export type Price = { input: number; output: number };

const MILLION = 1_000_000n;

export function costOf(p: Price, inputTokens: number, outputTokens: number): bigint {
  const raw = BigInt(Math.max(0, Math.floor(inputTokens))) * BigInt(p.input) + BigInt(Math.max(0, Math.floor(outputTokens))) * BigInt(p.output);
  return (raw + MILLION - 1n) / MILLION;
}

/** A rough upper bound for a request before it runs: 4 characters per token for the prompt, the output cap for the reply. */
export function estimateInputTokens(body: unknown): number {
  return Math.ceil(JSON.stringify(body ?? '').length / 4);
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
