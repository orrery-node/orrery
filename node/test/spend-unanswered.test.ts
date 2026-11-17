import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendUnanswered, readUnanswered, unansweredIn, unansweredNote } from '../src/spend.ts';

describe('requests no node answered', () => {
  it('are kept, and counted in a window', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-unanswered-')), 'router', 'unanswered.jsonl');
    const now = Date.now();
    appendUnanswered(path, { at: now - 2 * 86_400_000, model: 'm', asked: 3 });
    appendUnanswered(path, { at: now - 60_000, model: 'm', asked: 2 });
    appendUnanswered(path, { at: now - 1_000, model: 'n', asked: 1 });
    const all = readUnanswered(path);
    assert.equal(all.length, 3);
    assert.deepEqual(unansweredIn(all, 86_400_000, now), { requests: 2, nodes: 3 });
  });

  it('are said in one line, with nothing paid for them', () => {
    assert.equal(unansweredNote({ requests: 2, nodes: 3 }), '2 requests got no answer from any node asked (3 nodes asked in all); nothing was signed or paid for them.');
    assert.equal(unansweredNote({ requests: 1, nodes: 1 }), '1 request got no answer from the node asked; nothing was signed or paid for it.');
    assert.equal(unansweredNote({ requests: 0, nodes: 0 }), '');
  });
});
