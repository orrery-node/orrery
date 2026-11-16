// Server only. One read of every provider account on Solana, shared by the prices, private and burn pages. Each of them
// used to make its own read of the whole program on every refresh; now the three take turns on one, kept ten minutes.
import { Connection } from '@solana/web3.js';

export const PROVIDERS_KEPT_MS = 10 * 60_000;

type Held = { url: string; at: number; registry: Promise<unknown> };
const KEY = Symbol.for('orrery.web.providers');
const box = globalThis as unknown as Record<symbol, Held | undefined>;

/** The site's registry, refreshed at most once per ten minutes. A read that fails is dropped, so the next page that
 * asks tries again instead of waiting out the ten minutes. */
export function providers<R>(url: string, now = Date.now()): Promise<R> {
  const held = box[KEY];
  if (held && held.url === url && now - held.at < PROVIDERS_KEPT_MS) return held.registry as Promise<R>;
  const registry = (async () => {
    const { Registry } = (await import('orrery-node/dist/router/registry.js')) as unknown as {
      Registry: new (c: Connection, o: { allowDev: boolean; measurements: string[] }) => { refresh(): Promise<void> };
    };
    const r = new Registry(new Connection(url, 'confirmed'), { allowDev: false, measurements: [] });
    await r.refresh();
    return r;
  })();
  box[KEY] = { url, at: now, registry };
  registry.catch(() => {
    if (box[KEY]?.registry === registry) box[KEY] = undefined;
  });
  return registry as Promise<R>;
}
