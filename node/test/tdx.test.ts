import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTdxQuote, verifyTdx } from '../src/tee/tdx.ts';

// A real quote from an Intel Sapphire Rapids machine running TDX, published as test data by
// github.com/google/go-tdx-guest (testing/testdata/tdx_prod_quote_SPR_E4.dat).
const quote = readFileSync(new URL('./fixtures/tdx-spr-quote.dat', import.meta.url));
const parsed = parseTdxQuote(quote);
const when = new Date(new Date(new (await import('node:crypto')).X509Certificate(parsed.certs[0]).validFrom).getTime() + 86_400_000);
const base = { quote, measurement: Buffer.from(parsed.mrtd), enclaveKey: Buffer.from(parsed.reportData.subarray(0, 32)), now: when };

describe('built-in Intel TDX verifier', () => {
  it('accepts a real quote: platform chains to Intel’s root, the quoting enclave vouches for the key, the key signed the quote', () => {
    const v = verifyTdx(base);
    assert.equal(v.ok, true, v.reason);
  });
  it('refuses a quote with one bit changed', () => {
    const forged = Buffer.from(quote);
    forged[48 + 136] ^= 1;
    assert.match(verifyTdx({ ...base, quote: forged, measurement: Buffer.from(forged.subarray(48 + 136, 48 + 184)) }).reason, /not signed by the attested key/);
  });
  it('refuses another image, another key, and a chain that is not Intel’s', () => {
    assert.match(verifyTdx({ ...base, measurement: Buffer.alloc(48, 7) }).reason, /different image/);
    assert.match(verifyTdx({ ...base, enclaveKey: Buffer.alloc(32, 7) }).reason, /does not name this encryption key/);
    assert.match(verifyTdx({ ...base, root: '00' }).reason, /does not chain to Intel/);
  });
});
