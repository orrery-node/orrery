import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKeypair } from '../src/keys.ts';
import { newWallet, walletNextSteps } from '../src/wallet.ts';

describe('orrery wallet new', () => {
  it('writes a keypair file the Solana tools can read, for its owner only, and says its address', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), 'deep', 'wallet.json');
    const { address } = newWallet(path);
    const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
    assert.ok(Array.isArray(bytes) && bytes.length === 64 && bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
    assert.equal(loadKeypair(path).publicKey.toBase58(), address);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.notEqual(newWallet(join(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), 'wallet.json')).address, address, 'each one is new');
  });

  it('never replaces a file that is already there', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), 'wallet.json');
    const { address } = newWallet(path);
    const before = readFileSync(path, 'utf8');
    assert.throws(() => newWallet(path), new RegExp(`^Error: there is already a wallet at .*wallet\\.json \\(${address}\\); nothing was written$`));
    assert.equal(readFileSync(path, 'utf8'), before);
    const other = join(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), 'notes.txt');
    writeFileSync(other, 'not a key');
    assert.throws(() => newWallet(other), /^Error: there is already a file at .*notes\.txt; nothing was written$/);
    assert.equal(readFileSync(other, 'utf8'), 'not a key');
  });

  it('says what to send it and what comes next, and never the key', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-wallet-')), 'wallet.json');
    const { address } = newWallet(path);
    const said = walletNextSteps(path, address, '2');
    assert.match(said, new RegExp(`^wrote ${path}: a new Solana wallet, readable only by you\\. Back it up`));
    assert.match(said, new RegExp(`\\naddress {2}${address}\\n`));
    assert.match(said, /about 0\.01 SOL {3}for transaction fees and the rent of a payment channel/);
    assert.match(said, /\$2 opens the first channel/);
    assert.match(said, new RegExp(`then {2}orrery router --wallet ${path}`));
    assert.match(said, /\nTo run a node instead, send it about 0\.013 SOL and no USDC: the listing’s rent and fee money for the node’s key\.\n/);
    assert.match(said, new RegExp(`\\nthen {2}orrery provider init --wallet ${path} {3}\\(writes the node’s config with this wallet in it\\)$`));
    const secret = (JSON.parse(readFileSync(path, 'utf8')) as number[]).slice(0, 32).join(',');
    assert.ok(!said.includes(secret) && !/\[\d+,\d+/.test(said), 'the key itself is never printed');
  });

  it('names no --wallet for a wallet at the default place, since that is the one the router and doctor use', () => {
    const said = walletNextSteps('/h/.orrery/wallet.json', 'Addr111', '2', 'orrery', true);
    assert.match(said, /\nthen {2}orrery router {3}uses this wallet\n {6}orrery doctor {3}reads its balances and says what is ready\n/);
    assert.ok(!/router --wallet|doctor --wallet/.test(said), said);
    assert.match(said, /\nthen {2}orrery provider init {3}\(writes the node’s config with this wallet in it\)$/);
  });
});
