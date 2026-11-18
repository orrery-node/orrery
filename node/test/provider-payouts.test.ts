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
    assert.equal(rows!(p), `<tr><td>2026-11-18 14:05:11 UTC</td><td class=go>$0.050123</td><td>2</td><td title="${tx}">5GhKq2abcdef…</td><td></td></tr><tr><td>last 24 h</td><td class=go>$0.120000</td><td colspan=3>3 payouts</td></tr>`);
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
  });

  it('says in the log what the chain shows reached the wallet once a payout is sent', () => {
    const arrivalNote = (payouts as unknown as { arrivalNote?: (p: unknown, c: unknown) => string }).arrivalNote;
    assert.equal(typeof arrivalNote, 'function', 'payouts.ts writes the line');
    const p = { at: 0, units: '50123', channels: 2, tx: '5Gh4kQp9xTn2W7vLbYc8RfZaHs3mJe6G' };
    assert.equal(arrivalNote!(p, { state: 'landed', units: 50_123n }), "$0.050123 arrived in your wallet: the chain's record of tx 5Gh4kQp9xTn2… shows it in your USDC account");
    assert.equal(arrivalNote!(p, { state: 'landed', units: 40_000n }), 'tx 5Gh4kQp9xTn2… put $0.040000 in your wallet, not the $0.050123 this node redeemed. See orrery provider payouts');
    assert.equal(arrivalNote!(p, { state: 'failed' }), 'tx 5Gh4kQp9xTn2… failed on chain: nothing of the $0.050123 reached your wallet. See orrery provider payouts');
  });

  it('marks in the status each listed payout the node has seen arrive as kept, for the console', () => {
    const withChecked = (payouts as unknown as { withChecked?: (s: unknown, known: Map<string, unknown>) => { checked: unknown } | null }).withChecked;
    assert.equal(typeof withChecked, 'function', 'payouts.ts marks them');
    const s = { last: { at: 2, units: '5', channels: 1, tx: 'B' }, day: { units: '9', count: 2 }, recent: [{ at: 2, units: '5', channels: 1, tx: 'B' }, { at: 1, units: '4', channels: 1, tx: 'A' }] };
    assert.deepEqual(withChecked!(s, new Map([['A', { state: 'landed', units: 4n }], ['Z', { state: 'landed', units: 1n }]]))?.checked, { A: { state: 'landed', units: '4' } });
    assert.equal(withChecked!(null, new Map()), null);
  });
});
