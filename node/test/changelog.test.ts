import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as data from '../../web/src/data/changelog.ts';

describe('CHANGELOG.md', () => {
  it('is the text written from web/src/data/changelog.ts, word for word', () => {
    const write = (data as unknown as { changelogMarkdown?: () => string }).changelogMarkdown;
    assert.equal(typeof write, 'function', 'web/src/data/changelog.ts writes the file');
    assert.equal(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), write!());
  });

  it('names every release once, newest first, and each change has an audience', () => {
    const versions = data.RELEASES.map((r) => r.version);
    assert.equal(new Set(versions).size, versions.length);
    const at = data.RELEASES.map((r) => Date.parse(r.at));
    assert.ok(at.every((t, i) => Number.isFinite(t) && (i === 0 || t < at[i - 1])), 'newest first, by npm time');
    for (const c of [...data.UNRELEASED, ...data.RELEASES.flatMap((r) => r.changes)]) assert.ok(['router', 'provider', 'everyone'].includes(c.who) && c.text.length > 20);
  });
});
