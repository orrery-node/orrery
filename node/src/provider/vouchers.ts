// `orrery provider vouchers`: every voucher this node holds, checked against its channel on chain the way the program
// checks it at redeem: signed by the session key the router opened the channel with, for this node's listing, and paying
// the lower of the voucher and the deposit, less what is already settled. So an operator sees the money the node holds
// and that the chain will pay it, before any fee is spent on a redeem.
import { PublicKey } from '@solana/web3.js';
import { decodeVoucher, verifyVoucher } from '../chain/voucher.ts';
import type { ChannelAccount } from '../chain/program.ts';
import { usd } from '../pricing.ts';

export type VoucherRow = {
  channel: string;
  /** What the voucher says the router has paid in all, in micro-USDC. */
  cumulative: bigint;
  deposit: bigint | null;
  settled: bigint | null;
  /** Whether the channel's session key signed it: the program's own check. Null when the channel could not be read. */
  signed: boolean | null;
  /** What a redeem would move to the wallet now. */
  pays: bigint;
  /** When the payer started closing the channel (unix seconds): after it, the payer can take back what is left. */
  closingAt: number | null;
  problem?: string;
};

export function checkVouchers(ledger: Record<string, { best?: string }>, accounts: Map<string, ChannelAccount | null>, listing: PublicKey): VoucherRow[] {
  const rows: VoucherRow[] = [];
  for (const [address, entry] of Object.entries(ledger)) {
    if (!entry.best) continue;
    const v = decodeVoucher(entry.best);
    const ch = accounts.get(address) ?? null;
    if (!ch) {
      rows.push({ channel: address, cumulative: v.cumulative, deposit: null, settled: null, signed: null, pays: 0n, closingAt: null, problem: 'the channel is not on chain any more: it was closed, and what was not redeemed went back to the payer' });
      continue;
    }
    const signed = verifyVoucher(ch.sessionKey, new PublicKey(address), v);
    const forUs = ch.provider.equals(listing);
    const payable = v.cumulative < ch.deposit ? v.cumulative : ch.deposit;
    const pays = signed && forUs && payable > ch.redeemed ? payable - ch.redeemed : 0n;
    const problem = !forUs ? 'the channel is for another listing' : !signed ? "the signature is not the channel's session key: the program would refuse it" : undefined;
    rows.push({ channel: address, cumulative: v.cumulative, deposit: ch.deposit, settled: ch.redeemed, signed, pays, closingAt: ch.closingAt > 0n ? Number(ch.closingAt) : null, ...(problem ? { problem } : {}) });
  }
  return rows.sort((a, b) => (a.pays === b.pays ? a.channel.localeCompare(b.channel) : a.pays > b.pays ? -1 : 1));
}

const at = (s: number) => new Date(s * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export function renderVouchers(name: string, rows: VoucherRow[]): string {
  if (!rows.length) return `"${name}" holds no vouchers yet: a router signs one after each answer it pays for.`;
  const good = rows.filter((r) => r.signed === true && !r.problem).length;
  const lines = [`"${name}": ${rows.length} voucher${rows.length === 1 ? '' : 's'}, checked against each channel on chain the way the program checks a redeem`];
  for (const r of rows) {
    const head = `  ${r.channel.slice(0, 4)}…${r.channel.slice(-4)}  signed for $${usd(r.cumulative)}`;
    if (r.problem && r.signed === null) { lines.push(`${head}  ·  ${r.problem}`); continue; }
    const state = r.closingAt ? `closing: the payer can take back the rest after ${at(r.closingAt)}, so redeem before then` : 'open';
    lines.push(`${head} of a $${usd(r.deposit!)} deposit  ·  ${r.signed ? 'signature good' : 'signature bad'}  ·  $${usd(r.settled!)} settled  ·  $${usd(r.pays)} to redeem  ·  ${r.problem ?? state}`);
  }
  const total = rows.reduce((a, r) => a + r.pays, 0n);
  const redeemable = rows.filter((r) => r.pays > 0n).length;
  lines.push(`${good} of ${rows.length} would pass the program's check. $${usd(total)} can be redeemed now${redeemable ? `, in ${redeemable} transaction${redeemable === 1 ? '' : 's'}: orrery provider redeem` : ''}.`);
  return lines.join('\n');
}
