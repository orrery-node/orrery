import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as books from '../src/provider/books.ts';

describe('a node’s books for one UTC day', () => {
  const fns = books as unknown as {
    utcDay?: (ms: number) => string;
    dayBooksLine?: (day: string, served: { at: number; cost: string }[], payouts: { at: number; units: string; channels: number; tx: string }[], held: { at: number; units: string; tx: string } | null) => string | null;
  };
  const at = (iso: string) => Date.parse(iso);

  it('names the UTC day of a moment', () => {
    assert.equal(fns.utcDay?.(at('2026-11-18T23:59:59.999Z')), '2026-11-18');
    assert.equal(fns.utcDay?.(at('2026-11-19T00:00:00Z')), '2026-11-19');
  });

  it('says what the day billed, what it paid out and what the wallet then held, counting only that day', () => {
    assert.equal(typeof fns.dayBooksLine, 'function', 'books.ts writes the line');
    const served = [
      { at: at('2026-11-17T23:59:59Z'), cost: '0.900000' },
      { at: at('2026-11-18T00:00:00Z'), cost: '0.000031' },
      { at: at('2026-11-18T12:00:00Z'), cost: '0.038881' },
      { at: at('2026-11-19T00:00:00Z'), cost: '0.500000' },
    ];
    const payouts = [
      { at: at('2026-11-18T09:00:00Z'), units: '50123', channels: 2, tx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { at: at('2026-11-18T21:00:00Z'), units: '69877', channels: 1, tx: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      { at: at('2026-11-19T01:00:00Z'), units: '1', channels: 1, tx: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
    ];
    const held = { at: at('2026-11-18T21:00:03Z'), units: '1412500', tx: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
    assert.equal(fns.dayBooksLine!('2026-11-18', served, payouts, held), 'books for 2026-11-18 (UTC): 2 answers, $0.038912 billed; 2 payouts, $0.120000 to your wallet; it held $1.412500 after the last, per the chain');
    assert.equal(fns.dayBooksLine!('2026-11-18', served, payouts, { ...held, tx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), 'books for 2026-11-18 (UTC): 2 answers, $0.038912 billed; 2 payouts, $0.120000 to your wallet');
    assert.equal(fns.dayBooksLine!('2026-11-17', served, payouts, held), 'books for 2026-11-17 (UTC): 1 answer, $0.900000 billed; no payout');
    assert.equal(fns.dayBooksLine!('2026-11-16', served, payouts, held), null);
    assert.equal(fns.dayBooksLine!('not a day', served, payouts, held), null);
  });
});
