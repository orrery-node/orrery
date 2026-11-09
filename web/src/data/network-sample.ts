// Sample network for the /network preview. Every name, address and amount here is made up; the page says so wherever
// it shows them. The live board reads the same fields from each provider's account on Solana (settled, redeems,
// channels, bonded, registered_at, last_settled_at) once outside nodes are listed.

export type Kind = 'chat' | 'embedding';
export type Listing = { model: string; input: number; output: number; cached?: number };
export type SampleNode = {
  name: string;
  address: string;
  region: string;
  hardware: string;
  enclave: boolean;
  sinceDays: number;
  listings: Listing[];
  earned24: number;
  earnedAll: number;
  redeems: number;
  channels: number;
  ttftMs: number;
  uptime: number;
  bonded: number;
  lastRedeemMin: number;
  week: number[];
};

export const MODELS: { id: string; kind: Kind; input: number; output: number; cached?: number }[] = [
  { id: 'llama-3.3-70b', kind: 'chat', input: 0.12, output: 0.3 },
  { id: 'gpt-oss-120b', kind: 'chat', input: 0.035, output: 0.14, cached: 0.009 },
  { id: 'deepseek-v3', kind: 'chat', input: 0.27, output: 1.1, cached: 0.07 },
  { id: 'qwen3-32b', kind: 'chat', input: 0.08, output: 0.2 },
  { id: 'qwen3-coder-30b', kind: 'chat', input: 0.1, output: 0.4, cached: 0.025 },
  { id: 'gemma-3-27b', kind: 'chat', input: 0.2, output: 0.8 },
  { id: 'llama-3.1-8b', kind: 'chat', input: 0.02, output: 0.05 },
  { id: 'bge-m3', kind: 'embedding', input: 0.02, output: 0 },
  { id: 'nomic-embed-text', kind: 'embedding', input: 0.01, output: 0 },
];

const SPEC: { name: string; region: string; hardware: string; enclave?: boolean; sinceDays: number; models: string[]; load: number; ttftMs: number; uptime: number }[] = [
  { name: 'Ironbridge Compute', region: 'us-east', hardware: '8× H100', sinceDays: 41, models: ['llama-3.3-70b', 'deepseek-v3', 'gpt-oss-120b', 'bge-m3'], load: 1, ttftMs: 182, uptime: 99.97 },
  { name: 'Kestrel GPU Co-op', region: 'eu-north', hardware: '16× RTX 4090', sinceDays: 38, models: ['llama-3.3-70b', 'qwen3-32b', 'llama-3.1-8b'], load: 0.82, ttftMs: 236, uptime: 99.6 },
  { name: 'Larkspur Compute', region: 'us-west', hardware: '4× H200', sinceDays: 29, models: ['deepseek-v3', 'gpt-oss-120b', 'qwen3-coder-30b'], load: 0.74, ttftMs: 171, uptime: 99.92 },
  { name: 'Vault Nine', region: 'eu-west', hardware: '4× H100, TDX enclave', enclave: true, sinceDays: 36, models: ['qwen3-32b', 'llama-3.3-70b'], load: 0.51, ttftMs: 312, uptime: 99.88 },
  { name: 'Ferrous Labs', region: 'ap-southeast', hardware: '8× H100', sinceDays: 22, models: ['gpt-oss-120b', 'deepseek-v3'], load: 0.47, ttftMs: 204, uptime: 99.71 },
  { name: 'Halo Compute', region: 'ap-northeast', hardware: '8× A100', sinceDays: 33, models: ['gemma-3-27b', 'qwen3-32b'], load: 0.39, ttftMs: 258, uptime: 99.5 },
  { name: 'Moraine Inference', region: 'eu-central', hardware: '8× L40S', sinceDays: 18, models: ['llama-3.3-70b', 'gemma-3-27b', 'nomic-embed-text'], load: 0.33, ttftMs: 247, uptime: 99.41 },
  { name: 'Quillon Nodes', region: 'eu-north', hardware: '6× Mac Studio M3 Ultra', sinceDays: 12, models: ['qwen3-coder-30b', 'llama-3.1-8b'], load: 0.21, ttftMs: 289, uptime: 98.9 },
  { name: 'Saltmarsh 4090s', region: 'us-east', hardware: '6× RTX 4090', sinceDays: 9, models: ['qwen3-32b', 'bge-m3', 'nomic-embed-text'], load: 0.17, ttftMs: 221, uptime: 99.2 },
  { name: 'Otterline GPU', region: 'us-central', hardware: '2× RTX 4090, at home', sinceDays: 6, models: ['llama-3.1-8b', 'qwen3-32b'], load: 0.09, ttftMs: 274, uptime: 97.8 },
  { name: 'Tidewater Rack', region: 'sa-east', hardware: '4× RTX A6000', sinceDays: 4, models: ['llama-3.1-8b', 'gemma-3-27b'], load: 0.06, ttftMs: 331, uptime: 98.4 },
  { name: 'Cirrus Hollow', region: 'ap-northeast', hardware: '2× H100', sinceDays: 1, models: ['gpt-oss-120b', 'llama-3.3-70b'], load: 0.03, ttftMs: 197, uptime: 100 },
];

/** Small deterministic generator, so the server and the browser draw the same sample. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(r: () => number, n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += B58[Math.floor(r() * B58.length)];
  return s;
}
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const round = (x: number, step: number) => Math.round(x / step) * step;

export function sampleNetwork(): SampleNode[] {
  const r = rng(20261109);
  return SPEC.map((s) => {
    const listings: Listing[] = s.models.map((id) => {
      const m = MODELS.find((x) => x.id === id)!;
      const f = 0.86 + r() * 0.3;
      return {
        model: id,
        input: round(m.input * f, 0.001),
        output: round(m.output * f, 0.001),
        ...(m.cached !== undefined && r() > 0.3 ? { cached: round(m.cached * f, 0.0005) } : {}),
      };
    });
    const earned24 = round(s.load * (11.4 + r() * 1.6), 0.000001);
    const week = Array.from({ length: 7 }, (_, i) => (i < 7 - s.sinceDays ? 0 : round(earned24 * (0.55 + r() * 0.6) * (0.7 + (i / 6) * 0.3), 0.000001)));
    week[6] = earned24;
    const earnedAll = round(earned24 * Math.min(s.sinceDays, 60) * (0.48 + r() * 0.2), 0.000001);
    return {
      name: s.name,
      address: base58(r, 44),
      region: s.region,
      hardware: s.hardware,
      enclave: !!s.enclave,
      sinceDays: s.sinceDays,
      listings,
      earned24,
      earnedAll: Math.max(earnedAll, earned24),
      redeems: Math.round(s.sinceDays * (6 + s.load * 40) * (0.8 + r() * 0.4)),
      channels: Math.round(4 + s.load * 220 * (0.8 + r() * 0.4)),
      ttftMs: s.ttftMs,
      uptime: s.uptime,
      bonded: round(4_000 + s.load * 90_000 * (0.7 + r() * 0.6), 100),
      lastRedeemMin: Math.max(1, Math.round((1 - s.load) * 40 * r()) + 1),
      week,
    };
  });
}

export type TapeEvent =
  | { kind: 'redeem'; node: string; usd: number; channels: number; sig: string }
  | { kind: 'open'; node: string; usd: number; router: string }
  | { kind: 'topup'; node: string; usd: number; router: string }
  | { kind: 'listing'; node: string; model: string; input: number; output: number }
  | { kind: 'release'; node: string; usd: number; router: string };

/** One made-up chain event, weighted by how busy each sample node is. */
export function nextEvent(r: () => number, nodes: SampleNode[]): TapeEvent {
  const total = nodes.reduce((a, n) => a + n.earned24, 0);
  let pick = r() * total;
  const node = nodes.find((n) => (pick -= n.earned24) <= 0) ?? nodes[0];
  const x = r();
  if (x < 0.42) return { kind: 'redeem', node: node.name, usd: round(node.earned24 / (90 + r() * 120), 0.000001), channels: 1 + Math.floor(r() * Math.min(38, node.channels / 4)), sig: base58(r, 88) };
  if (x < 0.7) return { kind: 'open', node: node.name, usd: [0.5, 1, 2, 2, 5, 10][Math.floor(r() * 6)], router: base58(r, 44) };
  if (x < 0.86) return { kind: 'topup', node: node.name, usd: [0.5, 1, 1, 2][Math.floor(r() * 4)], router: base58(r, 44) };
  if (x < 0.95) return { kind: 'release', node: node.name, usd: round(0.02 + r() * 0.9, 0.000001), router: base58(r, 44) };
  const l = node.listings[Math.floor(r() * node.listings.length)];
  const f = 0.96 + r() * 0.06;
  return { kind: 'listing', node: node.name, model: l.model, input: round(l.input * f, 0.001), output: round(l.output * f, 0.001) };
}
