// A provider's price list. The node serves it at /v1/manifest; the sha256 of its canonical bytes is on chain, so a
// router can tell whether the list it fetched is the one the provider's wallet signed for.
import { createHash } from 'node:crypto';
import { checkTiers, type HolderTier } from './holder.ts';
import type { Price } from './pricing.ts';

export type ModelOffer = {
  id: string;
  context: number;
  maxOutput: number;
  price: Price;
  family?: string;
};

export type Manifest = {
  v: 1;
  name: string;
  authority: string;
  nodeKey: string;
  region?: string;
  models: ModelOffer[];
  tee?: { kind: number; enclaveKey: string };
  holder?: { tiers: HolderTier[] };
  /** A pledge to spend this share (basis points) of every USDC the node redeems on buying the network token and
   * burning it. It is part of the list the provider's wallet pinned on chain, and routers check it against the burns. */
  burn?: { share: number };
  /** The node's upstream continues a partial answer handed to it as a final assistant message, so a router can resume a
   * stream another provider dropped. */
  resume?: boolean;
  /** The node reads the channel and the voucher from inside the seal. Listed here, it is pinned on chain with the rest of
   * the list, so nothing in front of the node can take it away from a router that meets the node for the first time. */
  inside?: boolean;
};

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function canonical(m: Manifest): Buffer {
  return Buffer.from(JSON.stringify(sortKeys(m)), 'utf8');
}

export function manifestHash(m: Manifest | Buffer): Buffer {
  return createHash('sha256').update(Buffer.isBuffer(m) ? m : canonical(m)).digest();
}

const MODEL_ID = /^[a-z0-9][a-z0-9._\-/]{0,95}$/;

export function checkManifest(m: unknown): Manifest {
  const x = m as Manifest;
  if (!x || x.v !== 1 || typeof x.name !== 'string' || !Array.isArray(x.models)) throw new Error('manifest: bad shape');
  if (x.models.length > 512) throw new Error('manifest: too many models');
  for (const o of x.models) {
    if (!MODEL_ID.test(o.id)) throw new Error(`manifest: bad model id ${o.id}`);
    if (!Number.isSafeInteger(o.price?.input) || !Number.isSafeInteger(o.price?.output) || o.price.input < 0 || o.price.output < 0) throw new Error(`manifest: bad price for ${o.id}`);
    if (o.price.cachedInput !== undefined && (!Number.isSafeInteger(o.price.cachedInput) || o.price.cachedInput < 0 || o.price.cachedInput > o.price.input)) throw new Error(`manifest: cachedInput for ${o.id} must be between 0 and the input price`);
    if (!Number.isSafeInteger(o.context) || !Number.isSafeInteger(o.maxOutput) || o.maxOutput <= 0) throw new Error(`manifest: bad limits for ${o.id}`);
  }
  if (x.holder !== undefined) checkTiers(x.holder?.tiers);
  if (x.burn !== undefined && (!Number.isSafeInteger(x.burn?.share) || x.burn.share < 1 || x.burn.share > 10_000)) throw new Error('manifest: burn.share must be 1 to 10000 basis points');
  if (x.resume !== undefined && typeof x.resume !== 'boolean') throw new Error('manifest: resume must be true or false');
  if (x.inside !== undefined && x.inside !== true) throw new Error('manifest: inside, when listed, is true');
  return x;
}
