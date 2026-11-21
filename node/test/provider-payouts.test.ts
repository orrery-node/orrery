import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as payouts from '../src/provider/payouts.ts';
import * as own from '../src/provider/console.ts';
import { appendPayout, payoutLines, payoutSummary, readPayouts } from '../src/provider/payouts.ts';

describe('what a node has paid out to its wallet', () => {
  it('keeps each payout a line and reads them back, across the rolled file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-payouts-')), 'payouts.jsonl');
    appendPayout(path, { at: 1_000, units: '50123', channels: 1, tx: 'A'.repeat(88) }, 1);
    appendPayout(path, { at: 2_000, units: '70000', channels: 2, tx: 'B'.repeat(88) }, 1);
    assert.deepEqual(readPayouts(path).map((p) => [p.at, p.units, p.channels]), [[1_000, '50123', 1], [2_000, '70000', 2]]);
    assert.deepEqual(readPayouts(join(tmpdir(), 'orrery-nowhere', 'payouts.jsonl')), []);
  });

  it('sums the last 24 hours and finds the last payout, whatever order the lines are in', () => {
    const now = 100 * 86_400_000;
    const list = [
      { at: now - 2 * 86_400_000, units: '900000', channels: 1, tx: 'old' },
      { at: now - 720_000, units: '50123', channels: 1, tx: '5GhKq2abcdefXYZ' },
      { at: now - 3_600_000, units: '69877', channels: 2, tx: 'mid' },
    ];
    assert.deepEqual(payoutSummary(list, now), { last: list[1], day: { units: '120000', count: 2 }, recent: [list[1], list[2], list[0]] });
    assert.equal(payoutSummary([], now), null);
  });

  it('says when money last landed and what the day came to, or that none has yet', () => {
    const now = Date.parse('2026-11-18T14:17:11Z');
    const s = { last: { at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 1, tx: '5GhKq2abcdefXYZ' }, day: { units: '120000', count: 3 }, recent: [] };
    assert.deepEqual(payoutLines(s, now), [
      '  last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2abcdef…',
      '  paid out, last 24 h   $0.120000 in 3 payouts',
    ]);
    const old = { last: { ...s.last, at: Date.parse('2026-11-15T09:30:00Z') }, day: { units: '0', count: 0 }, recent: [] };
    assert.deepEqual(payoutLines(old, now), [
      '  last payout           $0.050123 to your wallet 3 days ago (2026-11-15 09:30 UTC)  tx 5GhKq2abcdef…',
      '  paid out, last 24 h   $0.000000 in 0 payouts',
    ]);
    assert.deepEqual(payoutLines(null, now), ['  last payout           none yet']);
    assert.deepEqual(payoutLines(null, now, true), ['  last payout           none recorded here yet; this listing was paid out on chain before']);
  });

  it('says the last payout arrived once the node has read it back from the chain as kept, and not otherwise', () => {
    const now = Date.parse('2026-11-18T14:17:11Z');
    const s = { last: { at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 1, tx: '5GhKq2abcdefXYZ' }, day: { units: '120000', count: 3 }, recent: [] };
    const lines = (checked: Record<string, { units: string }>) => (payoutLines as (x: unknown, n: number) => string[])({ ...s, checked }, now)[0];
    assert.equal(lines({ '5GhKq2abcdefXYZ': { units: '50123' } }), '  last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2abcdef…  arrived, per the chain');
    assert.equal(lines({ '5GhKq2abcdefXYZ': { units: '40000' } }), '  last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2abcdef…');
    assert.equal(lines({ other: { units: '50123' } }), '  last payout           $0.050123 to your wallet 12 min ago (14:05:11 UTC)  tx 5GhKq2abcdef…');
  });

  it('lists the latest payouts for the console, each with its transaction, and the last day under them', () => {
    const rows = (payouts as unknown as { payoutRows?: (p: unknown) => string }).payoutRows;
    assert.equal(typeof rows, 'function', 'payouts.ts renders the console rows');
    const tx = '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2abcdefXYZ';
    const p = { last: { at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 2, tx }, day: { units: '120000', count: 3 }, recent: [{ at: Date.parse('2026-11-18T14:05:11Z'), units: '50123', channels: 2, tx }] };
    assert.equal(rows!(p), `<tr><td>2026-11-18 14:05:11 UTC</td><td class=go>$0.050123</td><td>2</td><td title="${tx}"><button class=tx type=button data-tx="${tx}" aria-label="Copy the whole transaction">5GhKq2abcdef…</button></td><td></td></tr><tr><td>last 24 h</td><td class=go>$0.120000</td><td colspan=3>3 payouts</td></tr>`);
    assert.equal(rows!(null), '<tr class=empty><td colspan=5>None recorded here yet. Each payout this node sends to your wallet is listed here, with its transaction.</td></tr>');
  });

  it('says beside each payout what the chain says reached the wallet, once the console has checked', () => {
    const rows = (payouts as unknown as { payoutRows?: (p: unknown) => string }).payoutRows!;
    const t = (c: string) => `${c}${'x'.repeat(40)}`;
    const at = Date.parse('2026-11-18T14:05:11Z');
    const recent = [{ at, units: '50123', channels: 2, tx: t('A') }, { at, units: '70000', channels: 1, tx: t('B') }, { at, units: '1000', channels: 1, tx: t('C') }, { at, units: '2000', channels: 1, tx: t('D') }, { at, units: '3000', channels: 1, tx: t('E') }];
    const checked = { [t('A')]: { state: 'landed', units: '50123' }, [t('B')]: { state: 'landed', units: '60000' }, [t('C')]: { state: 'missing', units: null }, [t('D')]: { state: 'failed', units: null } };
    const cells = rows({ day: { units: '126123', count: 5 }, recent, checked }).split('</tr>').slice(0, 5).map((r) => r.slice(r.lastIndexOf('<td>') + 4, -'</td>'.length));
    assert.deepEqual(cells, ['<span class=go>arrived $0.050123</span>', '<span class=stop>arrived $0.060000</span>', '<span class=stop>no record on chain</span>', '<span class=stop>failed on chain</span>', '']);
  });

  it('checks each payout against the chain five at a time, and does not ask again about one that arrived as kept', async () => {
    const checkPayouts = (payouts as unknown as { checkPayouts?: (conn: unknown, list: unknown[], wallet: string, mint: string, known?: Map<string, unknown>) => Promise<{ chain: unknown }[]> }).checkPayouts;
    assert.equal(typeof checkPayouts, 'function', 'payouts.ts checks against the chain');
    const wallet = 'Wa11etWa11etWa11etWa11etWa11etWa11et', mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const bal = (amount: string) => ({ accountIndex: 4, mint, owner: wallet, uiTokenAmount: { amount } });
    const asked: string[] = [];
    const conn = { getTransaction: async (sig: string) => { asked.push(sig); if (sig === 'down') throw new Error('rpc down'); return sig === 'gone' ? null : { meta: { err: null, preTokenBalances: [bal('0')], postTokenBalances: [bal('500')] } }; } };
    const list = ['ok1', 'ok2', 'gone', 'down', 'ok3', 'ok4', 'short'].map((tx, i) => ({ at: i, units: tx === 'short' ? '600' : '500', channels: 1, tx }));
    const known = new Map();
    const first = await checkPayouts!(conn, list, wallet, mint, known);
    assert.deepEqual(first.map((r) => r.chain), [{ state: 'landed', units: 500n }, { state: 'landed', units: 500n }, { state: 'missing' }, null, { state: 'landed', units: 500n }, { state: 'landed', units: 500n }, { state: 'landed', units: 500n }]);
    assert.deepEqual([...known.keys()], ['ok1', 'ok2', 'ok3', 'ok4']);
    asked.length = 0;
    await checkPayouts!(conn, list, wallet, mint, known);
    assert.deepEqual(asked, ['gone', 'down', 'short']);
  });

  it('drops a kept line whose transaction is not a signature, so nothing from the file reaches the page as markup', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-payouts-')), 'payouts.jsonl');
    appendPayout(path, { at: 1, units: '1', channels: 1, tx: '<img src=x onerror=alert(1)>' });
    appendPayout(path, { at: 2, units: '2', channels: 1, tx: '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2abcdefXYZ' });
    assert.deepEqual(readPayouts(path).map((x) => x.at), [2]);
  });

  it('says what the last 24 hours billed, from the node’s own log, which a restart does not reset', () => {
    const dayLine = (own as unknown as { dayLine?: (t: unknown) => string }).dayLine;
    assert.equal(typeof dayLine, 'function', 'console.ts writes the line');
    assert.equal(dayLine!({ answers: 1312, usd: '0.038912' }), '  last 24 h             1,312 answers, $0.038912 billed');
    assert.equal(dayLine!({ answers: 1, usd: '0.000029' }), '  last 24 h             1 answer, $0.000029 billed');
    assert.equal(dayLine!({ answers: 0, usd: '0.000000' }), '  last 24 h             no answers');
  });

  it('says this UTC month so far under the last 24 hours: billed, payouts and what reached the wallet', () => {
    const monthLine = (own as unknown as { monthLine?: (m: unknown) => string }).monthLine;
    assert.equal(typeof monthLine, 'function', 'console.ts writes the line');
    assert.equal(monthLine!({ day: '2026-11', answers: 1312, billed: '0.038912', payouts: 3, paid: '0.120000' }), '  this month (UTC)      1,312 answers, $0.038912 billed; 3 payouts, $0.120000 to your wallet');
    assert.equal(monthLine!({ day: '2026-11', answers: 1, billed: '0.000029', payouts: 0, paid: '0.000000' }), '  this month (UTC)      1 answer, $0.000029 billed; 0 payouts, $0.000000 to your wallet');
    assert.equal(monthLine!({ day: '2026-12', answers: 0, billed: '0.000000', payouts: 0, paid: '0.000000' }), '  this month (UTC)      nothing yet');
  });

  it('says the last 24 hours by kind of work, only when the node did more than one kind', () => {
    const kindsLine = (own as unknown as { kindsLine?: (k: unknown) => string | null }).kindsLine;
    assert.equal(typeof kindsLine, 'function', 'console.ts writes the line');
    assert.equal(kindsLine!([{ key: 'chat', answers: 1312, usd: '0.038912' }, { key: 'rerank', answers: 4, usd: '0.000004' }]), '  by kind (24 h)        chat 1,312, $0.038912 · rerank 4, $0.000004');
    assert.equal(kindsLine!([{ key: 'chat', answers: 2, usd: '0.000030' }]), null);
    assert.equal(kindsLine!(undefined), null);
  });

  it('says what reached the wallet in the window earnings looks at, the last one, and nothing when nothing is kept', () => {
    const paidOutLine = (payouts as unknown as { paidOutLine?: (list: unknown[], sinceMs: number, since: string, now: number) => string | null }).paidOutLine;
    assert.equal(typeof paidOutLine, 'function', 'payouts.ts writes the line');
    const now = Date.parse('2026-11-18T14:17:11Z');
    const list = [
      { at: now - 2 * 86_400_000, units: '900000', channels: 1, tx: 'OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD' },
      { at: now - 3_600_000, units: '69877', channels: 2, tx: '3xR4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' },
      { at: now - 720_000, units: '50123', channels: 1, tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' },
    ];
    assert.equal(paidOutLine!(list, 86_400_000, '24h', now), 'paid out: $0.120000 to your wallet in 2 payouts in the last 24h, the last 12 min ago (tx 5Gh4kQp9xTn2…)');
    assert.equal(paidOutLine!(list, 7 * 86_400_000, '7d', now), 'paid out: $1.020000 to your wallet in 3 payouts in the last 7d, the last 12 min ago (tx 5Gh4kQp9xTn2…)');
    assert.equal(paidOutLine!(list.slice(0, 1), 3_600_000, '1h', now), 'paid out: none in the last 1h; the last was 2026-11-16 14:17 UTC');
    assert.equal(paidOutLine!([], 86_400_000, '24h', now), null);
  });

  it('reads from the chain’s record of a payout what reached the wallet’s USDC account, counting an opened account from zero', () => {
    const landedUnits = (payouts as unknown as { landedUnits?: (tx: unknown, wallet: string, mint: string) => unknown }).landedUnits;
    assert.equal(typeof landedUnits, 'function', 'payouts.ts reads the chain’s record');
    const wallet = 'Wa11etWa11etWa11etWa11etWa11etWa11et', mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', other = 'OtherOtherOtherOtherOtherOtherOther1';
    const bal = (accountIndex: number, owner: string, amount: string, m = mint) => ({ accountIndex, mint: m, owner, uiTokenAmount: { amount } });
    const tx = { meta: { err: null, preTokenBalances: [bal(3, other, '900000'), bal(4, wallet, '1000000')], postTokenBalances: [bal(3, other, '849877'), bal(4, wallet, '1050123')] } };
    assert.deepEqual(landedUnits!(tx, wallet, mint), { state: 'landed', units: 50_123n });
    const opened = { meta: { err: null, preTokenBalances: [bal(3, other, '900000')], postTokenBalances: [bal(3, other, '849877'), bal(5, wallet, '50123')] } };
    assert.deepEqual(landedUnits!(opened, wallet, mint), { state: 'landed', units: 50_123n });
    const otherMint = { meta: { err: null, preTokenBalances: [bal(4, wallet, '0', other)], postTokenBalances: [bal(4, wallet, '50123', other)] } };
    assert.deepEqual(landedUnits!(otherMint, wallet, mint), { state: 'landed', units: 0n });
    assert.deepEqual(landedUnits!({ meta: { err: { InstructionError: [0, 'Custom'] }, preTokenBalances: [], postTokenBalances: [] } }, wallet, mint), { state: 'failed' });
    assert.deepEqual(landedUnits!(null, wallet, mint), { state: 'missing' });
  });

  it('lists each kept payout beside what the chain says arrived, and adds up the ones that arrived as kept', () => {
    const payoutCheckLines = (payouts as unknown as { payoutCheckLines?: (name: string, rows: unknown[], total: number) => string[] }).payoutCheckLines;
    assert.equal(typeof payoutCheckLines, 'function', 'payouts.ts writes the lines');
    const at = Date.parse('2026-11-18T14:05:11Z');
    const a = { at, units: '50123', channels: 2, tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' };
    const b = { at: at - 3_600_000, units: '69877', channels: 1, tx: '3xR4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' };
    assert.deepEqual(payoutCheckLines!('ironbridge', [{ p: a, chain: { state: 'landed', units: 50_123n } }, { p: b, chain: { state: 'landed', units: 69_877n } }], 7), [
      '"ironbridge", the last 2 of 7 payouts kept here, each checked against the chain',
      '  2026-11-18 14:05:11 UTC  $0.050123  2 channels  tx 5Gh4kQp9xTn2…  arrived $0.050123',
      '  2026-11-18 13:05:11 UTC  $0.069877  1 channel   tx 3xR4kQp9xTn2…  arrived $0.069877',
      '2 of 2 arrived in your wallet as kept here, $0.120000 in all',
    ]);
    const mixed = payoutCheckLines!('ironbridge', [{ p: a, chain: { state: 'landed', units: 40_000n } }, { p: b, chain: { state: 'missing' } }, { p: { ...b, tx: 'FAILFAILFAILFAILFAILFAILFAILFAIL' }, chain: { state: 'failed' } }, { p: b, chain: null }], 4);
    assert.equal(mixed[1], '  2026-11-18 14:05:11 UTC  $0.050123  2 channels  tx 5Gh4kQp9xTn2…  arrived $0.040000, kept here as $0.050123');
    assert.equal(mixed[2].endsWith('the RPC has no record of it'), true);
    assert.equal(mixed[3].endsWith('failed on chain'), true);
    assert.equal(mixed[4].endsWith('not checked'), true);
    assert.equal(mixed[5], '0 of 3 arrived in your wallet as kept here, $0.000000 in all; 3 did not (see above); 1 not checked, the RPC did not answer');
    assert.equal(payoutCheckLines!('ironbridge', [{ p: a, chain: null }], 1).at(-1), 'the RPC did not answer; nothing was checked');
    assert.match(payoutCheckLines!('ironbridge', [], 0)[0], /^"ironbridge" has kept no payout yet\./);
    assert.equal(payoutCheckLines!('ironbridge', [{ p: a, chain: { state: 'landed', units: 50_123n }, after: 1_250_123n }], 1)[1], '  2026-11-18 14:05:11 UTC  $0.050123  2 channels  tx 5Gh4kQp9xTn2…  arrived $0.050123, wallet then $1.250123');
    assert.equal(payoutCheckLines!('ironbridge', [{ p: a, chain: { state: 'failed' }, after: 1_250_123n }], 1)[1].endsWith('failed on chain'), true);
  });

  it('says in the log what the chain shows reached the wallet once a payout is sent', () => {
    const arrivalNote = (payouts as unknown as { arrivalNote?: (p: unknown, c: unknown) => string }).arrivalNote;
    assert.equal(typeof arrivalNote, 'function', 'payouts.ts writes the line');
    const p = { at: 0, units: '50123', channels: 2, tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' };
    assert.equal(arrivalNote!(p, { state: 'landed', units: 50_123n }), "$0.050123 arrived in your wallet: the chain's record of tx 5Gh4kQp9xTn2… shows it in your USDC account");
    assert.equal(arrivalNote!(p, { state: 'landed', units: 40_000n }), 'tx 5Gh4kQp9xTn2… put $0.040000 in your wallet, not the $0.050123 this node redeemed. See orrery provider payouts');
    assert.equal(arrivalNote!(p, { state: 'failed' }), 'tx 5Gh4kQp9xTn2… failed on chain: nothing of the $0.050123 reached your wallet. See orrery provider payouts');
    const withBalance = arrivalNote as unknown as (p: unknown, c: unknown, after: bigint | null) => string;
    assert.equal(withBalance(p, { state: 'landed', units: 50_123n }, 1_250_123n), "$0.050123 arrived in your wallet: the chain's record of tx 5Gh4kQp9xTn2… shows it in your USDC account, which then held $1.250123");
    assert.equal(withBalance(p, { state: 'landed', units: 40_000n }, 1_250_123n), 'tx 5Gh4kQp9xTn2… put $0.040000 in your wallet, not the $0.050123 this node redeemed. See orrery provider payouts');
  });

  it('reads from the same record what the wallet’s USDC account held right after the payout', () => {
    const balanceAfter = (payouts as unknown as { balanceAfter?: (tx: unknown, wallet: string, mint: string) => bigint | null }).balanceAfter;
    assert.equal(typeof balanceAfter, 'function', 'payouts.ts reads it');
    const wallet = 'Wa11etWa11etWa11etWa11etWa11etWa11et', mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const bal = (owner: string, amount: string, m = mint) => ({ accountIndex: 4, mint: m, owner, uiTokenAmount: { amount } });
    assert.equal(balanceAfter!({ meta: { err: null, preTokenBalances: [bal(wallet, '1200000')], postTokenBalances: [bal('other', '9'), bal(wallet, '1250123', 'otherMint'), bal(wallet, '1250123')] } }, wallet, mint), 1_250_123n);
    assert.equal(balanceAfter!({ meta: { err: null, preTokenBalances: [], postTokenBalances: [bal('other', '9')] } }, wallet, mint), null);
    assert.equal(balanceAfter!(null, wallet, mint), null);
  });

  it('marks in the status each listed payout the node has seen arrive as kept, for the console', () => {
    const withChecked = (payouts as unknown as { withChecked?: (s: unknown, known: Map<string, unknown>) => { checked: unknown } | null }).withChecked;
    assert.equal(typeof withChecked, 'function', 'payouts.ts marks them');
    const s = { last: { at: 2, units: '5', channels: 1, tx: 'B' }, day: { units: '9', count: 2 }, recent: [{ at: 2, units: '5', channels: 1, tx: 'B' }, { at: 1, units: '4', channels: 1, tx: 'A' }] };
    assert.deepEqual(withChecked!(s, new Map([['A', { state: 'landed', units: 4n }], ['Z', { state: 'landed', units: 1n }]]))?.checked, { A: { state: 'landed', units: '4' } });
    assert.equal(withChecked!(null, new Map()), null);
  });

  it('judges each channel on its own for the next payout: over the floor, closing, or a first payout goes; the rest waits', () => {
    const nextPayout = (payouts as unknown as { nextPayout?: (c: { pending: bigint; closing: boolean }[], floor: bigint, every: number, first: boolean) => Record<string, unknown> }).nextPayout;
    assert.equal(typeof nextPayout, 'function', 'payouts.ts counts it');
    const two = [{ pending: 30_000n, closing: false }, { pending: 30_000n, closing: false }];
    assert.deepEqual(nextPayout!(two, 50_000n, 60, false), { due: '0', dueChannels: 0, below: '60000', belowChannels: 2, floor: '50000', everySecs: 60, first: false });
    assert.deepEqual(nextPayout!([...two, { pending: 4_000n, closing: true }, { pending: 61_000n, closing: false }, { pending: 0n, closing: true }], 50_000n, 60, false), { due: '65000', dueChannels: 2, below: '60000', belowChannels: 2, floor: '50000', everySecs: 60, first: false });
    assert.deepEqual(nextPayout!(two, 50_000n, 60, true), { due: '60000', dueChannels: 2, below: '0', belowChannels: 0, floor: '50000', everySecs: 60, first: true });
  });

  it('says when money next goes to the wallet, in the console and in provider status', () => {
    const sentence = (payouts as unknown as { nextPayoutSentence?: (n: unknown) => string }).nextPayoutSentence;
    const hint = (own as unknown as { nextPayoutHint?: (n: unknown, cfg: string) => string }).nextPayoutHint;
    assert.equal(typeof sentence, 'function', 'payouts.ts writes the sentence');
    assert.equal(typeof hint, 'function', 'console.ts writes the hint');
    const n = (due: string, dc: number, below: string, bc: number, first = false) => ({ due, dueChannels: dc, below, belowChannels: bc, floor: '50000', everySecs: 60, first });
    assert.equal(sentence!(n('0', 0, '4211', 1)), '$0.004211 is waiting in 1 channel. It pays out once it reaches $0.050000 or its router closes it; this node checks every 1 min.');
    assert.equal(sentence!(n('61000', 1, '0', 0)), '$0.061000 is due and goes out in the next round, within 1 min.');
    assert.equal(sentence!(n('21', 1, '0', 0, true)), '$0.000021 goes out in the next round, within 1 min, as this node’s first payout.');
    assert.equal(sentence!(n('61000', 1, '60000', 2)), '$0.061000 is due and goes out in the next round, within 1 min. $0.060000 more waiting in 2 channels. Each pays out once it reaches $0.050000 or its router closes it; this node checks every 1 min.');
    assert.equal(sentence!(n('0', 0, '0', 0)), 'Nothing is waiting to be paid out.');
    assert.equal(sentence!(undefined), '');
    assert.equal(hint!(n('0', 0, '60000', 2), 'provider.json'), '  (each channel pays out by itself at $0.05; orrery provider redeem --config provider.json does it now)');
    assert.equal(hint!(n('0', 0, '4211', 1), 'provider.json'), '  (pays out by itself at $0.05; orrery provider redeem --config provider.json does it now)');
    assert.equal(hint!(n('61000', 1, '60000', 2), 'provider.json'), '  ($0.061000 at the next round, every 1 min; $0.060000 waits for $0.05 a channel)');
    assert.equal(hint!({ ...n('21', 1, '0', 0, true), everySecs: 300 }, 'provider.json'), '  (your first payout: pays out at the next round, every 5 min)');
    assert.equal(hint!(n('0', 0, '0', 0), 'provider.json'), '');
  });

  it('keeps what the wallet held after the last payout read back from the chain, across a restart, and refuses markup', () => {
    const io = payouts as unknown as { writeHeld?: (path: string, h: unknown) => void; readHeld?: (path: string) => unknown };
    assert.equal(typeof io.writeHeld, 'function', 'payouts.ts keeps it');
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-held-')), 'held.json');
    assert.equal(io.readHeld!(path), null);
    io.writeHeld!(path, { at: 5, units: '1250123', tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' });
    assert.deepEqual(io.readHeld!(path), { at: 5, units: '1250123', tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' });
    io.writeHeld!(path, { at: 6, units: '1', tx: '<img src=x onerror=alert(1)>' });
    assert.equal(io.readHeld!(path), null);
  });

  it('says in provider status what the wallet held after the last payout, per the chain, as the console does', () => {
    const walletLine = (payouts as unknown as { walletLine?: (h: unknown) => string }).walletLine;
    assert.equal(typeof walletLine, 'function', 'payouts.ts writes the line');
    assert.equal(walletLine!({ at: 5, units: '1412500', tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' }), '  in your wallet        $1.412500 after the last payout, per the chain (tx 5Gh4kQp9xTn2…)');
  });

  it('makes each payout’s transaction a button that copies the whole signature, and links nowhere', () => {
    const rows = (payouts as unknown as { payoutRows: (p: unknown) => string }).payoutRows;
    const tx = '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2';
    const html = rows({ day: { units: '50123', count: 1 }, recent: [{ at: 0, units: '50123', channels: 1, tx }] });
    assert.ok(html.includes(`<td title="${tx}"><button class=tx type=button data-tx="${tx}" aria-label="Copy the whole transaction">5GhKq2abcdef…</button></td>`));
    assert.ok(!/<a\b|https?:/.test(html), 'no link and no address of another computer');
  });

  it('posts each payout’s arrival to the notify webhook as the log’s own line, under text and content, with the figures', () => {
    const notice = (payouts as unknown as { payoutNotice?: (node: string, p: unknown, c: unknown, after?: bigint | null) => { text: string; content: string; payout: Record<string, string | null> } }).payoutNotice;
    assert.equal(typeof notice, 'function', 'payouts.ts writes the notice');
    const p = { at: Date.parse('2026-11-19T14:05:00Z'), units: '50123', channels: 2, tx: '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2' };
    const landed = notice!('Kestrel', p, { state: 'landed', units: 50123n }, 1412500n);
    assert.equal(landed.text, "Kestrel: $0.050123 arrived in your wallet: the chain's record of tx 5GhKq2abcdef… shows it in your USDC account, which then held $1.412500");
    assert.equal(landed.content, landed.text);
    assert.deepEqual(landed.payout, { node: 'Kestrel', at: '2026-11-19T14:05:00.000Z', tx: p.tx, state: 'landed', redeemed: '0.050123', arrived: '0.050123', walletAfter: '1.412500' });
    const failed = notice!('Kestrel', p, { state: 'failed' });
    assert.ok(failed.text.startsWith('Kestrel: tx 5GhKq2abcdef… failed on chain'));
    assert.equal(failed.payout.arrived, null);
  });

  it('takes the webhook from notify.url or the variable notify.urlEnv names, and refuses an address that is not http(s)', () => {
    const url = (payouts as unknown as { notifyUrl?: (n: unknown, env?: Record<string, string>) => string | null }).notifyUrl;
    assert.equal(typeof url, 'function', 'payouts.ts reads notify');
    assert.equal(url!(undefined), null);
    assert.equal(url!({ url: 'https://hooks.example.com/T1/B2/c3' }), 'https://hooks.example.com/T1/B2/c3');
    assert.equal(url!({ urlEnv: 'HOOK' }, { HOOK: 'http://127.0.0.1:9/x' }), 'http://127.0.0.1:9/x');
    assert.throws(() => url!({ urlEnv: 'HOOK' }, {}), /HOOK is not set/);
    assert.throws(() => url!({ url: 'file:///etc/passwd' }), /https:\/\/ or http:\/\//);
    assert.throws(() => url!({ url: 'not a url' }), /not a URL/);
  });

  it('says what the webhook answered, and null when it cannot be reached', async () => {
    const post = (payouts as unknown as { postNotice?: (url: string, body: unknown, f: typeof fetch) => Promise<number | null> }).postNotice;
    assert.equal(typeof post, 'function', 'payouts.ts posts the notice');
    const sent: { url: string; init: RequestInit }[] = [];
    const ok = (async (u: string, init: RequestInit) => { sent.push({ url: u, init }); return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await post!('https://hooks.example.com/x', { text: 'hi' }, ok), 200);
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(JSON.parse(String(sent[0].init.body)).text, 'hi');
    assert.equal((sent[0].init.headers as Record<string, string>)['content-type'], 'application/json');
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    assert.equal(await post!('https://hooks.example.com/x', {}, down), null);
  });

  it('says where payout notices go and whether the last one got through, kept across a restart', () => {
    const f = payouts as unknown as { noticeLine?: (host: string, last: unknown, now?: number) => string; writeNotice?: (path: string, n: unknown) => void; readNotice?: (path: string) => unknown };
    assert.equal(typeof f.noticeLine, 'function', 'payouts.ts writes the line');
    const now = Date.parse('2026-11-19T16:00:00Z');
    assert.equal(f.noticeLine!('hooks.slack.com', null, now), '  payout notices        to hooks.slack.com; none sent yet (the first goes with the next payout)');
    assert.equal(f.noticeLine!('hooks.slack.com', { at: now - 300_000, what: 'payout', status: 200 }, now), '  payout notices        to hooks.slack.com; the last, a payout 5 min ago, got through (HTTP 200)');
    assert.equal(f.noticeLine!('discord.com', { at: now - 7_200_000, what: 'books', status: 404 }, now), '  payout notices        to discord.com; the last, the day’s books 2 h ago, was refused (HTTP 404); check the webhook address');
    assert.equal(f.noticeLine!('hooks.slack.com', { at: now - 30_000, what: 'payout', status: null }, now), '  payout notices        to hooks.slack.com; the last, a payout 30 s ago, could not reach it');
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-notice-')), 'notice.json');
    assert.equal(f.readNotice!(path), null);
    f.writeNotice!(path, { at: 7, what: 'books', status: null });
    assert.deepEqual(f.readNotice!(path), { at: 7, what: 'books', status: null });
    f.writeNotice!(path, { at: 8, what: '<b>', status: 200 });
    assert.equal(f.readNotice!(path), null);
  });
});
