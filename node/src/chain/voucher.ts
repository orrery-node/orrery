// The voucher is the only thing that moves money out of a channel: 88 bytes the router's session key signs, the
// same bytes program/programs/switchyard/src/voucher.rs rebuilds and checks against the runtime's ed25519 check.
import { Ed25519Program, PublicKey, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519Verify, type Sign } from '../keys.ts';
import { ins } from './program.ts';

export const VOUCHER_PREFIX = Buffer.from('switchyard/vch/1');

export type Voucher = { cumulative: bigint; usageHash: Buffer; signature: Buffer };

export function voucherMessage(channel: PublicKey, cumulative: bigint, usageHash: Uint8Array): Buffer {
  if (usageHash.length !== 32) throw new Error('usage hash must be 32 bytes');
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(cumulative);
  return Buffer.concat([VOUCHER_PREFIX, channel.toBuffer(), amount, Buffer.from(usageHash)]);
}

export function signVoucher(sign: Sign, channel: PublicKey, cumulative: bigint, usageHash: Uint8Array): Voucher {
  return { cumulative, usageHash: Buffer.from(usageHash), signature: Buffer.from(sign(voucherMessage(channel, cumulative, usageHash))) };
}

export function verifyVoucher(sessionKey: PublicKey, channel: PublicKey, v: Voucher): boolean {
  return ed25519Verify(sessionKey.toBytes(), voucherMessage(channel, v.cumulative, v.usageHash), v.signature);
}

export function encodeVoucher(v: Voucher): string {
  return `${v.cumulative}.${v.usageHash.toString('hex')}.${bs58.encode(v.signature)}`;
}

export function decodeVoucher(s: string): Voucher {
  const [amount, hash, sig] = s.split('.');
  if (!amount || !/^\d{1,20}$/.test(amount) || !hash || !/^[0-9a-f]{64}$/.test(hash) || !sig) throw new Error('malformed voucher');
  const signature = Buffer.from(bs58.decode(sig));
  if (signature.length !== 64) throw new Error('malformed voucher signature');
  return { cumulative: BigInt(amount), usageHash: Buffer.from(hash, 'hex'), signature };
}

/** The pair a redeem transaction needs: the runtime's signature check, then the program call that relies on it. */
export function redeemInstructions(o: {
  caller: PublicKey; providerAuthority: PublicKey; channel: PublicKey; mint: PublicKey; sessionKey: PublicKey; voucher: Voucher; programId?: PublicKey;
}): TransactionInstruction[] {
  const message = voucherMessage(o.channel, o.voucher.cumulative, o.voucher.usageHash);
  const check = Ed25519Program.createInstructionWithPublicKey({ publicKey: o.sessionKey.toBytes(), message, signature: o.voucher.signature });
  return [check, ins.redeem(o.caller, o.providerAuthority, o.channel, o.mint, o.voucher.cumulative, o.voucher.usageHash, o.programId)];
}
