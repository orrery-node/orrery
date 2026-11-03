// Private route: the router encrypts the request to the enclave key the provider attested on chain (X25519 +
// HKDF-SHA256 + AES-256-GCM). Only code inside that enclave holds the private half, so the operator's host, the
// network and this project see ciphertext. Replies come back sealed under the same derived key.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const INFO = Buffer.from('orrery/seal/1');

export type EnclaveKey = { publicKey: Buffer; privateKey: KeyObject; secret: Buffer };

export function newEnclaveKey(): EnclaveKey {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { publicKey: Buffer.from(pub), privateKey, secret: Buffer.from(secret) };
}

export function enclaveKeyFromSecret(secret: Buffer): EnclaveKey {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, secret]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: Buffer.from(pub), privateKey, secret };
}

const publicFromRaw = (raw: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });

function derive(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, recipient]), INFO, 32));
}

export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

export function decrypt(key: Buffer, box: Buffer): Buffer {
  if (box.length < 28) throw new Error('sealed box too short');
  const d = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
  d.setAuthTag(box.subarray(box.length - 16));
  return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
}

/** Router side: seal a request to an enclave. Returns the wire body and the key that will open the reply. */
export function sealRequest(enclavePublic: Buffer, plaintext: Buffer): { body: string; key: Buffer } {
  const eph = newEnclaveKey();
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(enclavePublic) });
  const key = derive(shared, eph.publicKey, enclavePublic);
  return { body: JSON.stringify({ sealed: 1, epk: eph.publicKey.toString('base64'), box: encrypt(key, plaintext).toString('base64') }), key };
}

/** Enclave side: open a sealed request. Returns the plaintext and the key to seal the reply with. */
export function openRequest(enclave: EnclaveKey, wire: { epk: string; box: string }): { plaintext: Buffer; key: Buffer } {
  const epk = Buffer.from(wire.epk, 'base64');
  const shared = diffieHellman({ privateKey: enclave.privateKey, publicKey: publicFromRaw(epk) });
  const key = derive(shared, epk, enclave.publicKey);
  return { plaintext: decrypt(key, Buffer.from(wire.box, 'base64')), key };
}
