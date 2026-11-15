// `orrery wallet new`: a wallet file for someone who has none. The same file works for a router (it opens payment
// channels) and for a node (it lists the node and is paid). Only its address is ever printed.
import { existsSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { loadKeypair, writePrivate } from './keys.ts';

/** Makes a keypair file in the form the Solana tools use (a JSON array of 64 bytes), readable by its owner only. A
 * file that is already there is never replaced: it may be the only copy of a funded wallet. */
export function newWallet(path: string): { address: string } {
  if (existsSync(path)) {
    const holds = (() => { try { return loadKeypair(path).publicKey.toBase58(); } catch { return null; } })();
    throw new Error(holds ? `there is already a wallet at ${path} (${holds}); nothing was written` : `there is already a file at ${path}; nothing was written`);
  }
  const kp = Keypair.generate();
  writePrivate(path, JSON.stringify(Array.from(kp.secretKey)));
  return { address: kp.publicKey.toBase58() };
}

/** What to do with a new wallet: what to send it and the commands that come next, for a router and for a node. */
export function walletNextSteps(path: string, address: string, depositUsd: string, cli = 'orrery'): string {
  return [
    `wrote ${path}: a new Solana wallet, readable only by you. Back it up: there is no other copy and nobody can recover it.`,
    `address  ${address}`,
    'To use the network, send that address on Solana:',
    '  about 0.01 SOL   for transaction fees and the rent of a payment channel',
    `  USDC to spend    $${depositUsd} opens the first channel; close a channel and what you did not spend comes back`,
    `then  ${cli} router --wallet ${path}   (a wallet at the default place is used without --wallet)`,
    `      ${cli} doctor --wallet ${path}   reads its balances and says what is ready`,
    `To run a node instead, send it about 0.013 SOL and no USDC: the listing’s rent and fee money for the node’s key.`,
    `then  ${cli} provider init --wallet ${path}   (writes the node’s config with this wallet in it)`,
  ].join('\n');
}
