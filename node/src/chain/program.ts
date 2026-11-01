// Hand-written client for the Switchyard program: PDAs, account layouts and instruction encodings. It mirrors
// program/programs/switchyard/src/lib.rs field for field; test/program.test.ts checks it against the built IDL.
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_ID } from '../brand.ts';

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export const programId = (): PublicKey => new PublicKey(PROGRAM_ID);

const disc = (ns: string, name: string): Buffer => createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8);

export const IX = Object.fromEntries(
  ['initialize', 'set_params', 'set_bond_mint', 'register_provider', 'update_provider', 'attest', 'bond', 'unbond', 'withdraw_bond', 'open_channel', 'top_up', 'redeem', 'request_close', 'close_channel'].map((n) => [n, disc('global', n)]),
) as Record<string, Buffer>;

export const ACCOUNT = { Config: disc('account', 'Config'), Provider: disc('account', 'Provider'), Channel: disc('account', 'Channel') };

export const TEE_KINDS = ['none', 'Intel TDX', 'AMD SEV-SNP', 'Intel TDX + NVIDIA CC'] as const;

const seed = (s: string) => Buffer.from(s);
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

export const pda = {
  config: (pid = programId()) => PublicKey.findProgramAddressSync([seed('config')], pid)[0],
  provider: (authority: PublicKey, pid = programId()) => PublicKey.findProgramAddressSync([seed('provider'), authority.toBuffer()], pid)[0],
  channel: (payer: PublicKey, provider: PublicKey, id: bigint, pid = programId()) =>
    PublicKey.findProgramAddressSync([seed('channel'), payer.toBuffer(), provider.toBuffer(), u64le(id)], pid)[0],
  ata: (owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM) =>
    PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0],
  programData: (pid = programId()) => PublicKey.findProgramAddressSync([pid.toBuffer()], UPGRADEABLE_LOADER)[0],
};

class Writer {
  private parts: Buffer[] = [];
  u8(n: number) { this.parts.push(Buffer.from([n])); return this; }
  u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n: bigint) { this.parts.push(u64le(n)); return this; }
  i64(n: bigint) { const b = Buffer.alloc(8); b.writeBigInt64LE(n); this.parts.push(b); return this; }
  pk(k: PublicKey) { this.parts.push(k.toBuffer()); return this; }
  bytes(b: Uint8Array, len: number) {
    if (b.length !== len) throw new Error(`expected ${len} bytes, got ${b.length}`);
    this.parts.push(Buffer.from(b));
    return this;
  }
  str(s: string) { const b = Buffer.from(s, 'utf8'); this.u32(b.length); this.parts.push(b); return this; }
  opt<T>(v: T | undefined, put: (v: T) => void) { if (v === undefined) this.u8(0); else { this.u8(1); put(v); } return this; }
  done() { return Buffer.concat(this.parts); }
}

class Reader {
  at = 8;
  constructor(private b: Buffer) {}
  u8() { return this.b.readUInt8(this.at++); }
  bool() { return this.u8() === 1; }
  u32() { const v = this.b.readUInt32LE(this.at); this.at += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.at); this.at += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.at); this.at += 8; return v; }
  pk() { const v = new PublicKey(this.b.subarray(this.at, this.at + 32)); this.at += 32; return v; }
  bytes(n: number) { const v = Buffer.from(this.b.subarray(this.at, this.at + n)); this.at += n; return v; }
  str() { const n = this.u32(); const v = this.b.subarray(this.at, this.at + n).toString('utf8'); this.at += n; return v; }
}

export type ConfigAccount = {
  admin: PublicKey; pendingAdmin: PublicKey; settleMint: PublicKey; bondMint: PublicKey;
  closeGraceSecs: bigint; unbondSecs: bigint; minDeposit: bigint; providers: bigint; channels: bigint; settled: bigint;
};

export type ProviderAccount = {
  authority: PublicKey; nodeKey: PublicKey; endpoint: string; manifestHash: Buffer; manifestSeq: number; active: boolean;
  teeKind: number; teeMeasurement: Buffer; teeReportHash: Buffer; teeKey: Buffer; teeExpiresAt: bigint;
  bonded: bigint; unbonding: bigint; unbondAt: bigint; settled: bigint; redeems: bigint; channels: bigint;
  registeredAt: bigint; lastSettledAt: bigint;
};

export type ChannelAccount = {
  payer: PublicKey; provider: PublicKey; sessionKey: PublicKey; mint: PublicKey; id: bigint;
  deposit: bigint; redeemed: bigint; usageHash: Buffer; openedAt: bigint; closingAt: bigint;
};

function expect(data: Buffer, d: Buffer, name: string) {
  if (data.length < 8 || !data.subarray(0, 8).equals(d)) throw new Error(`not a ${name} account`);
}

export function decodeConfig(data: Buffer): ConfigAccount {
  expect(data, ACCOUNT.Config, 'Config');
  const r = new Reader(data);
  return {
    admin: r.pk(), pendingAdmin: r.pk(), settleMint: r.pk(), bondMint: r.pk(),
    closeGraceSecs: r.i64(), unbondSecs: r.i64(), minDeposit: r.u64(), providers: r.u64(), channels: r.u64(), settled: r.u64(),
  };
}

export function decodeProvider(data: Buffer): ProviderAccount {
  expect(data, ACCOUNT.Provider, 'Provider');
  const r = new Reader(data);
  return {
    authority: r.pk(), nodeKey: r.pk(), endpoint: r.str(), manifestHash: r.bytes(32), manifestSeq: r.u32(), active: r.bool(),
    teeKind: r.u8(), teeMeasurement: r.bytes(48), teeReportHash: r.bytes(32), teeKey: r.bytes(32), teeExpiresAt: r.i64(),
    bonded: r.u64(), unbonding: r.u64(), unbondAt: r.i64(), settled: r.u64(), redeems: r.u64(), channels: r.u64(),
    registeredAt: r.i64(), lastSettledAt: r.i64(),
  };
}

export function decodeChannel(data: Buffer): ChannelAccount {
  expect(data, ACCOUNT.Channel, 'Channel');
  const r = new Reader(data);
  return {
    payer: r.pk(), provider: r.pk(), sessionKey: r.pk(), mint: r.pk(), id: r.u64(),
    deposit: r.u64(), redeemed: r.u64(), usageHash: r.bytes(32), openedAt: r.i64(), closingAt: r.i64(),
  };
}

type Meta = [PublicKey, boolean, boolean];
const ix = (data: Buffer, metas: Meta[], pid = programId()) =>
  new TransactionInstruction({ programId: pid, keys: metas.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data });

export const ins = {
  initialize(admin: PublicKey, settleMint: PublicKey, p: { closeGraceSecs: bigint; unbondSecs: bigint; minDeposit: bigint }, pid = programId()) {
    const data = new Writer().bytes(IX.initialize, 8).i64(p.closeGraceSecs).i64(p.unbondSecs).u64(p.minDeposit).done();
    return ix(data, [[admin, true, true], [pid, false, false], [pda.programData(pid), false, false], [pda.config(pid), false, true], [settleMint, false, false], [SystemProgram.programId, false, false]], pid);
  },

  registerProvider(authority: PublicKey, nodeKey: PublicKey, endpoint: string, manifestHash: Uint8Array, pid = programId()) {
    const data = new Writer().bytes(IX.register_provider, 8).pk(nodeKey).str(endpoint).bytes(manifestHash, 32).done();
    return ix(data, [[authority, true, true], [pda.config(pid), false, true], [pda.provider(authority, pid), false, true], [SystemProgram.programId, false, false]], pid);
  },

  updateProvider(authority: PublicKey, a: { nodeKey?: PublicKey; endpoint?: string; manifestHash?: Uint8Array; active?: boolean }, pid = programId()) {
    const w = new Writer().bytes(IX.update_provider, 8);
    w.opt(a.nodeKey, (k) => w.pk(k));
    w.opt(a.endpoint, (s) => w.str(s));
    w.opt(a.manifestHash, (h) => w.bytes(h, 32));
    w.opt(a.active, (v) => w.u8(v ? 1 : 0));
    return ix(w.done(), [[authority, true, false], [pda.provider(authority, pid), false, true]], pid);
  },

  attest(signer: PublicKey, providerAuthority: PublicKey, a: { kind: number; measurement: Uint8Array; reportHash: Uint8Array; teeKey: Uint8Array; expiresAt: bigint }, pid = programId()) {
    const data = new Writer().bytes(IX.attest, 8).u8(a.kind).bytes(a.measurement, 48).bytes(a.reportHash, 32).bytes(a.teeKey, 32).i64(a.expiresAt).done();
    return ix(data, [[signer, true, false], [pda.provider(providerAuthority, pid), false, true]], pid);
  },

  openChannel(payer: PublicKey, provider: PublicKey, mint: PublicKey, id: bigint, deposit: bigint, sessionKey: PublicKey, pid = programId()) {
    const channel = pda.channel(payer, provider, id, pid);
    const data = new Writer().bytes(IX.open_channel, 8).u64(id).u64(deposit).pk(sessionKey).done();
    return ix(data, [
      [payer, true, true], [pda.config(pid), false, true], [provider, false, true], [channel, false, true], [mint, false, false],
      [pda.ata(payer, mint), false, true], [pda.ata(channel, mint), false, true], [TOKEN_PROGRAM, false, false], [ATA_PROGRAM, false, false], [SystemProgram.programId, false, false],
    ], pid);
  },

  topUp(payer: PublicKey, channel: PublicKey, mint: PublicKey, amount: bigint, pid = programId()) {
    const data = new Writer().bytes(IX.top_up, 8).u64(amount).done();
    return ix(data, [[payer, true, false], [channel, false, true], [mint, false, false], [pda.ata(payer, mint), false, true], [pda.ata(channel, mint), false, true], [TOKEN_PROGRAM, false, false]], pid);
  },

  redeem(caller: PublicKey, providerAuthority: PublicKey, channel: PublicKey, mint: PublicKey, cumulative: bigint, usageHash: Uint8Array, pid = programId()) {
    const provider = pda.provider(providerAuthority, pid);
    const data = new Writer().bytes(IX.redeem, 8).u64(cumulative).bytes(usageHash, 32).done();
    return ix(data, [
      [caller, true, true], [pda.config(pid), false, true], [provider, false, true], [channel, false, true], [mint, false, false],
      [pda.ata(channel, mint), false, true], [providerAuthority, false, false], [pda.ata(providerAuthority, mint), false, true],
      [SYSVAR_INSTRUCTIONS_PUBKEY, false, false], [TOKEN_PROGRAM, false, false], [ATA_PROGRAM, false, false], [SystemProgram.programId, false, false],
    ], pid);
  },

  requestClose(payer: PublicKey, channel: PublicKey, pid = programId()) {
    return ix(new Writer().bytes(IX.request_close, 8).done(), [[payer, true, false], [pda.config(pid), false, false], [channel, false, true]], pid);
  },

  closeChannel(closer: PublicKey, providerAuthority: PublicKey, channel: PublicKey, payer: PublicKey, mint: PublicKey, pid = programId()) {
    return ix(new Writer().bytes(IX.close_channel, 8).done(), [
      [closer, true, true], [pda.provider(providerAuthority, pid), false, false], [channel, false, true], [payer, false, true], [mint, false, false],
      [pda.ata(channel, mint), false, true], [pda.ata(payer, mint), false, true], [TOKEN_PROGRAM, false, false], [ATA_PROGRAM, false, false], [SystemProgram.programId, false, false],
    ], pid);
  },
};
