import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { HOME_DIR } from './brand.ts';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

export function home(...parts: string[]): string {
  return join(process.env.ORRERY_HOME ?? join(homedir(), HOME_DIR), ...parts);
}

export function writePrivate(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o600 });
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

export function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  writePrivate(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export type Sign = (message: Uint8Array) => Uint8Array;

export function signerOf(kp: Keypair): Sign {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(kp.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
  return (message) => new Uint8Array(sign(null, message, key));
}

export function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey)]), format: 'der', type: 'spki' });
  return verify(null, message, key, signature);
}
