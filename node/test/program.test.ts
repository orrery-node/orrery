import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ACCOUNT, IX, pda, programId } from '../src/chain/program.ts';
import { decodeVoucher, encodeVoucher, signVoucher, verifyVoucher, voucherMessage } from '../src/chain/voucher.ts';
import { signerOf } from '../src/keys.ts';

const IDL = new URL('../../program/target/idl/switchyard.json', import.meta.url);

describe('client matches the program', () => {
  it('instruction and account discriminators equal the built IDL', { skip: !existsSync(IDL) && 'build the program first' }, () => {
    const idl = JSON.parse(readFileSync(IDL, 'utf8'));
    assert.equal(idl.address, programId().toBase58());
    for (const ix of idl.instructions) {
      if (IX[ix.name]) assert.deepEqual([...IX[ix.name]], ix.discriminator, ix.name);
    }
    for (const a of idl.accounts) assert.deepEqual([...ACCOUNT[a.name as keyof typeof ACCOUNT]], a.discriminator, a.name);
  });

  it('voucher bytes match the layout in voucher.rs', () => {
    const ch = new PublicKey(Buffer.alloc(32, 3));
    const m = voucherMessage(ch, 1_234_567n, Buffer.alloc(32, 9));
    assert.equal(m.length, 88);
    assert.equal(m.subarray(0, 16).toString(), 'switchyard/vch/1');
    assert.deepEqual(m.subarray(16, 48), ch.toBuffer());
    assert.equal(m.readBigUInt64LE(48), 1_234_567n);
    assert.deepEqual(m.subarray(56), Buffer.alloc(32, 9));
  });

  it('a voucher verifies only for its key, channel and total, and survives the header encoding', () => {
    const session = Keypair.generate();
    const ch = pda.channel(Keypair.generate().publicKey, Keypair.generate().publicKey, 42n);
    const v = signVoucher(signerOf(session), ch, 5_000n, Buffer.alloc(32, 1));
    assert.ok(verifyVoucher(session.publicKey, ch, v));
    assert.ok(!verifyVoucher(Keypair.generate().publicKey, ch, v));
    assert.ok(!verifyVoucher(session.publicKey, pda.channel(session.publicKey, ch, 1n), v));
    assert.ok(!verifyVoucher(session.publicKey, ch, { ...v, cumulative: 5_001n }));
    const back = decodeVoucher(encodeVoucher(v));
    assert.equal(back.cumulative, 5_000n);
    assert.ok(verifyVoucher(session.publicKey, ch, back));
    assert.throws(() => decodeVoucher('12.zz.abc'));
  });
});
