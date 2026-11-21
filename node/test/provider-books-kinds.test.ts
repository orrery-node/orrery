import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { booksNotice, dayKinds } from '../src/provider/books.ts';

const at = (iso: string) => Date.parse(iso);
const kindOf = (m: string) => (m === 'flux-schnell' ? 'image' : m === 'kokoro-82m' ? 'speech' : 'chat');
const served = [
  { at: at('2026-11-18T01:00:00Z'), cost: '0.000400', model: 'llama-3.3-70b' },
  { at: at('2026-11-18T02:00:00Z'), cost: '0.006002', model: 'flux-schnell' },
  { at: at('2026-11-18T03:00:00Z'), cost: '0.000014', model: 'kokoro-82m' },
  { at: at('2026-11-19T00:00:00Z'), cost: '0.900000', model: 'flux-schnell' },
];

describe('the day the node closes, by kind of work', () => {
  it('adds up each kind of work in the UTC day, most billed first', () => {
    assert.deepEqual(dayKinds('2026-11-18', served, kindOf), [
      { kind: 'image', answers: 1, units: 6_002n },
      { kind: 'chat', answers: 1, units: 400n },
      { kind: 'speech', answers: 1, units: 14n },
    ]);
  });

  it('gives the notify webhook the kinds as JSON when there was more than one, and nothing more when there was one', () => {
    const kept = { day: '2026-11-18', answers: 3, billed: '6416', payouts: 0, paid: '0' };
    const many = booksNotice('Ironbridge Compute', 'books for 2026-11-18 (UTC): …', kept, dayKinds('2026-11-18', served, kindOf));
    assert.deepEqual(many.books?.kinds, [{ kind: 'image', answers: 1, billed: '0.006002' }, { kind: 'chat', answers: 1, billed: '0.000400' }, { kind: 'speech', answers: 1, billed: '0.000014' }]);
    const one = booksNotice('Kestrel', 'books for 2026-11-18 (UTC): …', kept, dayKinds('2026-11-18', served.filter((t) => t.model === 'llama-3.3-70b'), kindOf));
    assert.equal('kinds' in (one.books ?? {}), false);
    assert.equal('kinds' in (booksNotice('Kestrel', 'line', kept).books ?? {}), false);
  });
});
