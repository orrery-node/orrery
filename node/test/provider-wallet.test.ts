import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { ProviderNode, type ProviderConfig } from '../src/provider/node.ts';

const cfg = (dir: string, over: Partial<ProviderConfig>): ProviderConfig => ({
  name: 'New node', listen: 0, publicUrl: 'https://node.example.com', rpcUrl: 'http://127.0.0.1:1', settleMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  dataDir: dir, upstream: { baseUrl: 'http://127.0.0.1:1/v1' }, models: [], ...over,
} as ProviderConfig);

describe('a node started before its wallet file exists', () => {
  it('says which file is missing, what the node needs it for, and the two ways on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-wallet-'));
    const missing = join(dir, 'nowhere', 'id.json');
    assert.throws(() => new ProviderNode(cfg(dir, { wallet: missing })), (e: Error) => {
      assert.ok(!/ENOENT/.test(e.message), e.message);
      assert.match(e.message, new RegExp(`there is no keypair at ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(e.message, /"authority"/);
      assert.match(e.message, /provider register/);
      assert.match(e.message, /No wallet yet\? orrery wallet new --out \S+ makes one/);
      return true;
    });
  });

  it('needs no wallet file at all when the config names the wallet’s address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-wallet-'));
    const wallet = Keypair.generate();
    const byAddress = new ProviderNode(cfg(dir, { authority: wallet.publicKey.toBase58() }));
    const file = join(dir, 'id.json');
    writeFileSync(file, JSON.stringify(Array.from(wallet.secretKey)));
    const byFile = new ProviderNode(cfg(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), { wallet: file }));
    assert.equal(byAddress.pda.toBase58(), byFile.pda.toBase58());
  });

  it('takes the wallet’s address from ORRERY_AUTHORITY when the config has no authority and the wallet file is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-wallet-'));
    const wallet = Keypair.generate();
    const byAddress = new ProviderNode(cfg(dir, { authority: wallet.publicKey.toBase58() }));
    process.env.ORRERY_AUTHORITY = wallet.publicKey.toBase58();
    try {
      const inContainer = new ProviderNode(cfg(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), { wallet: join(dir, 'not-mounted', 'wallet.json') }));
      assert.equal(inContainer.pda.toBase58(), byAddress.pda.toBase58());
    } finally {
      delete process.env.ORRERY_AUTHORITY;
    }
  });
});
