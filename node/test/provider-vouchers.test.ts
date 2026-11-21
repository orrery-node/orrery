import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encodeVoucher, signVoucher } from '../src/chain/voucher.ts';
import { signerOf } from '../src/keys.ts';
import type { ChannelAccount } from '../src/chain/program.ts';
import { checkVouchers, renderVouchers } from '../src/provider/vouchers.ts';

const session = Keypair.generate();
const listing = Keypair.generate().publicKey;
const channelOf = (o: Partial<ChannelAccount> = {}): ChannelAccount => ({
  payer: Keypair.generate().publicKey, provider: listing, sessionKey: session.publicKey, mint: Keypair.generate().publicKey, id: 1n,
  deposit: 500_000n, redeemed: 0n, usageHash: Buffer.alloc(32), openedAt: 1n, closingAt: 0n, ...o,
});
const voucherFor = (channel: PublicKey, cumulative: bigint, key = session) => encodeVoucher(signVoucher(signerOf(key), channel, cumulative, Buffer.alloc(32, 7)));

describe('orrery provider vouchers', () => {
  it('checks each voucher the way the program checks a redeem: the session key signed it, and it pays the lower of it and the deposit, less what is settled', () => {
    const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    const rows = checkVouchers(
      { [a.toBase58()]: { best: voucherFor(a, 913n) }, [b.toBase58()]: { best: voucherFor(b, 700_000n) } },
      new Map([[a.toBase58(), channelOf({ redeemed: 863n })], [b.toBase58(), channelOf({ deposit: 500_000n, redeemed: 100_000n })]]),
      listing,
    );
    assert.deepEqual(rows.map((r) => [r.channel, r.signed, r.pays, r.problem]), [[b.toBase58(), true, 400_000n, undefined], [a.toBase58(), true, 50n, undefined]]);
    const text = renderVouchers('Ironbridge Compute', rows);
    assert.match(text, /^"Ironbridge Compute": 2 vouchers, checked against each channel on chain the way the program checks a redeem$/m);
    assert.match(text, /signed for \$0\.000913 of a \$0\.500000 deposit {2}· {2}signature good {2}· {2}\$0\.000863 settled {2}· {2}\$0\.000050 to redeem {2}· {2}open$/m);
    assert.match(text, /^2 of 2 would pass the program's check\. \$0\.400050 can be redeemed now, in 2 transactions: orrery provider redeem\.$/m);
  });

  it('says when a voucher would be refused: a signature that is not the session key, or a channel for another listing', () => {
    const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
    const rows = checkVouchers(
      { [a.toBase58()]: { best: voucherFor(a, 900n, Keypair.generate()) }, [b.toBase58()]: { best: voucherFor(b, 900n) } },
      new Map([[a.toBase58(), channelOf()], [b.toBase58(), channelOf({ provider: Keypair.generate().publicKey })]]),
      listing,
    );
    assert.equal(rows.find((r) => r.channel === a.toBase58())?.problem, "the signature is not the channel's session key: the program would refuse it");
    assert.equal(rows.find((r) => r.channel === b.toBase58())?.problem, 'the channel is for another listing');
    assert.ok(rows.every((r) => r.pays === 0n));
    assert.match(renderVouchers('N', rows), /^0 of 2 would pass the program's check\. \$0\.000000 can be redeemed now\.$/m);
  });

  it('a tampered amount fails the signature, a closing channel says by when to redeem, and a closed one says the rest went back', () => {
    const a = Keypair.generate().publicKey, c = Keypair.generate().publicKey, gone = Keypair.generate().publicKey;
    const real = voucherFor(a, 900n);
    const tampered = real.replace(/^900\./, '9000.');
    const rows = checkVouchers(
      { [a.toBase58()]: { best: tampered }, [c.toBase58()]: { best: voucherFor(c, 400n) }, [gone.toBase58()]: { best: voucherFor(gone, 10n) }, nothing: {} },
      new Map<string, ChannelAccount | null>([[a.toBase58(), channelOf()], [c.toBase58(), channelOf({ closingAt: 1_795_000_000n })], [gone.toBase58(), null]]),
      listing,
    );
    assert.equal(rows.length, 3);
    assert.equal(rows.find((r) => r.channel === a.toBase58())?.signed, false);
    const text = renderVouchers('N', rows);
    assert.match(text, /\$0\.000400 to redeem {2}· {2}closing: the payer can take back the rest after 2026-11-18 11:06 UTC, so redeem before then$/m);
    assert.match(text, /signed for \$0\.000010 {2}· {2}the channel is not on chain any more/);
    assert.equal(renderVouchers('N', []), '"N" holds no vouchers yet: a router signs one after each answer it pays for.');
  });
});
