// Reads the last voucher the Orrery program accepted for the site's public demo channel (the one /try shows), straight
// from Solana mainnet: the 88-byte message and the 64-byte signature are in the transaction's ed25519 check.
//   cd node && npx tsx devtools/last-voucher.ts <channel address> > ../media/x/film/voucher/voucher.json
// Nothing here is private: the channel and its payer are printed by the demo itself, and the rest is on chain.
import { Connection, Ed25519Program, PublicKey } from '@solana/web3.js';
import { decodeChannel } from '../src/chain/program.ts';
import { voucherMessage, VOUCHER_PREFIX } from '../src/chain/voucher.ts';
import { ed25519Verify } from '../src/keys.ts';

const channel = new PublicKey(process.argv[2]);
const conn = new Connection(process.env.ORRERY_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
const acct = await conn.getAccountInfo(channel);
if (!acct) throw new Error('no such channel');
const ch = decodeChannel(acct.data);

const sigs = await conn.getSignaturesForAddress(channel, { limit: 25 });
let found: Record<string, unknown> | null = null;
for (const s of sigs) {
  if (s.err) continue;
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  for (const ix of tx.transaction.message.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(Ed25519Program.programId)) continue;
    const d = Buffer.from(ix.data);
    // One check: offsets of the signature, the public key and the message inside this instruction's own data.
    const sigAt = d.readUInt16LE(2), keyAt = d.readUInt16LE(6), msgAt = d.readUInt16LE(10), msgLen = d.readUInt16LE(12);
    const message = d.subarray(msgAt, msgAt + msgLen), signature = d.subarray(sigAt, sigAt + 64), key = d.subarray(keyAt, keyAt + 32);
    if (msgLen !== 88 || !message.subarray(0, 16).equals(VOUCHER_PREFIX) || !message.subarray(16, 48).equals(channel.toBuffer())) continue;
    const cumulative = message.readBigUInt64LE(48), usageHash = message.subarray(56, 88);
    const rebuilt = voucherMessage(channel, cumulative, usageHash);
    if (!rebuilt.equals(message)) throw new Error('the message on chain is not what voucherMessage builds');
    if (!ed25519Verify(key, message, signature)) throw new Error('the signature does not verify');
    if (!new PublicKey(key).equals(ch.sessionKey)) throw new Error('signed by a key that is not this channel’s session key');
    found = {
      channel: channel.toBase58(), slot: tx.slot, blockTime: tx.blockTime, tx: s.signature,
      message: message.toString('hex'), signature: signature.toString('hex'), sessionKey: new PublicKey(key).toBase58(),
      cumulative: cumulative.toString(), usageHash: usageHash.toString('hex'),
      onChain: { redeemed: ch.redeemed.toString(), deposit: ch.deposit.toString(), usageHash: ch.usageHash.toString('hex') },
      headMatches: ch.redeemed === cumulative && ch.usageHash.equals(usageHash),
    };
    break;
  }
  if (found) break;
}
if (!found) throw new Error('no redemption found in the last 25 transactions of this channel');
console.log(JSON.stringify(found, null, 1));
