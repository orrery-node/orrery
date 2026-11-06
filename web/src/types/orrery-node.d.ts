// The published orrery-node package ships JavaScript only. The site loads its router modules on the server for the
// "try it" page; these are the few shapes it touches.
declare module 'orrery-node/dist/router/server.js' {
  export const Router: new (o: Record<string, unknown>) => {
    trips: { at: number; model: string; route: string; provider: string; providerName: string; inputTokens: number; outputTokens: number; cost: string; ttftMs: number; totalMs: number; sealed: boolean; fellThrough: number; off?: number }[];
    start(): Promise<unknown>;
    close(): Promise<void>;
    stats: { all(): Map<string, { cooldownUntil: number }> };
  };
}
declare module 'orrery-node/dist/router/channels.js' {
  export const Channels: new (...a: unknown[]) => {
    list(): { provider: string; channel: string; deposit: bigint; cumulative: bigint }[];
    todaySpent(): bigint;
    ensure(provider: string, need: bigint): Promise<unknown>;
  };
}
declare module 'orrery-node/dist/router/registry.js' {
  export const Registry: new (...a: unknown[]) => { usable(): { address: string }[] };
}
declare module 'orrery-node/dist/holder.js' {
  export const HolderBook: new (...a: unknown[]) => unknown;
}
declare module 'orrery-node/dist/brand.js' {
  export const USDC_MAINNET: string;
}
declare module 'orrery-node/dist/keys.js' {
  export function loadOrCreateKeypair(path: string): import('@solana/web3.js').Keypair;
}
