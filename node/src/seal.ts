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

/** Router side: seal a request to a key. Returns the wire body and the key that will open the reply. `tag` says whose
 * key it is: `sealed` for an enclave's, `wire` for the node process's own (see wireMessage). */
export function sealRequest(enclavePublic: Buffer, plaintext: Buffer, tag: 'sealed' | 'wire' = 'sealed'): { body: string; key: Buffer } {
  const eph = newEnclaveKey();
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(enclavePublic) });
  const key = derive(shared, eph.publicKey, enclavePublic);
  return { body: JSON.stringify({ [tag]: 1, epk: eph.publicKey.toString('base64'), box: encrypt(key, plaintext).toString('base64') }), key };
}

/** A request padded with spaces to its size class: 1 KiB, doubling up to 64 KiB, then every 64 KiB. A sealed body is
 * as long as what was sealed, and it is all that the network, a proxy or a node's balancer see of a request, so this
 * leaves them the class and not the prompt's length. JSON ignores the spaces, so any node opens it as before. */
export function padRequest(plaintext: Buffer): Buffer {
  const n = plaintext.length;
  const size = n <= 1024 ? 1024 : n <= 65_536 ? 2 ** Math.ceil(Math.log2(n)) : Math.ceil(n / 65_536) * 65_536;
  return size === n ? plaintext : Buffer.concat([plaintext, Buffer.alloc(size - n, 0x20)]);
}

/** One frame of an answer padded with spaces to whole 256-byte blocks. A streamed answer goes out about a token per
 * frame, and the length of each sealed frame is what is visible on the way, so unpadded frames spell out the length
 * of every token. A frame of one token fits one block, so short and long tokens look the same. JSON ignores the
 * spaces. What still shows: how many frames, and when. */
export function padFrame(text: string): Buffer {
  const b = Buffer.from(text);
  const size = Math.max(256, Math.ceil(b.length / 256) * 256);
  return size === b.length ? b : Buffer.concat([b, Buffer.alloc(size - b.length, 0x20)]);
}

/** Enclave side: open a sealed request. Returns the plaintext and the key to seal the reply with. */
export function openRequest(enclave: EnclaveKey, wire: { epk: string; box: string }): { plaintext: Buffer; key: Buffer } {
  const epk = Buffer.from(wire.epk, 'base64');
  const shared = diffieHellman({ privateKey: enclave.privateKey, publicKey: publicFromRaw(epk) });
  const key = derive(shared, epk, enclave.publicKey);
  return { plaintext: decrypt(key, Buffer.from(wire.box, 'base64')), key };
}

/** Wire sealing. Every node holds an X25519 key of its own and signs it with the node key that is on chain, so a
 * router can encrypt each request to the node process itself. The operator can still read the prompt (only an enclave
 * prevents that), but nothing between the two machines can: not the node's hosting platform, its load balancer or a
 * firewall in front of it, which otherwise see the plain request after TLS ends and may block or log it. */
export const wireMessage = (key: Buffer) => Buffer.concat([Buffer.from('orrery/wire/1'), key]);

/** What a node signs with the same node key to say it reads the channel and the voucher from inside the seal, for this
 * wire key. Without it a router keeps payment in headers, so nothing in front of a node can claim this for one. */
export const insideMessage = (key: Buffer) => Buffer.concat([Buffer.from('orrery/wire-inside/1'), key]);
