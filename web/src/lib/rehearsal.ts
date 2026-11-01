import data from '@/data/rehearsal.json';

export type RTrip = { route: string; model: string; provider: string; tokens: string; cost: string; ttftMs: number; sealed: boolean; fellThrough: number };
export type RProvider = {
  name: string; region: string; enclave: boolean; address: string; models: { id: string; input: number; output: number }[];
  channel?: string; cumulative?: string; usageHash?: string; voucher?: string | null; redeemTx?: string | null;
};

export const rehearsal = data as unknown as {
  ranAt: string; program: string; requests: number; settledUnits: string; session: string;
  trips: RTrip[]; providers: RProvider[]; balances: { user: string; providers: string; deposits: string };
  checks: { name: string; ok: boolean; detail: string }[];
};

export const ranAtLabel = (() => {
  const d = new Date(rehearsal.ranAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
})();

export const units = (s: string | bigint) => (typeof s === 'bigint' ? s : BigInt(s));

export function usd(u: bigint, digits = 6): string {
  const whole = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, '0').slice(0, digits);
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

export const costUnits = (cost: string) => BigInt(Math.round(Number(cost) * 1e6));

export const perM = (u: number) => `$${(u / 1e6).toFixed(2)}`;

export const ROUTE_WORD: Record<string, string> = { auto: 'auto', price: ':cheap', speed: ':fast', reputation: ':trusted', privacy: ':private' };

export const short = (s: string, a = 4, b = 4) => `${s.slice(0, a)}…${s.slice(-b)}`;
