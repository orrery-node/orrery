// Each paid request extends a hash chain over what it cost and why. The router signs the chain head inside every
// voucher and the program stores the head it redeems, so either side can later prove which requests a payment covered.
import { createHash } from 'node:crypto';

export type UsageRecord = { requestId: string; model: string; inputTokens: number; outputTokens: number; cost: bigint };

export const ZERO_HASH = Buffer.alloc(32);

export function nextUsageHash(prev: Uint8Array, r: UsageRecord): Buffer {
  return createHash('sha256').update(prev).update(`${r.requestId}|${r.model}|${r.inputTokens}|${r.outputTokens}|${r.cost}`).digest();
}
