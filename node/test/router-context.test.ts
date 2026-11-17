import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitting, textTokensAtLeast } from '../src/router/context.ts';

const chat = (content: unknown, system?: string) => ({ model: 'm', messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }] });

describe('a prompt and the context a node lists', () => {
  it('counts the text of a request at five characters a token, and nothing else', () => {
    assert.equal(textTokensAtLeast(chat('a'.repeat(1000))), 200);
    assert.equal(textTokensAtLeast(chat('a'.repeat(500), 'b'.repeat(500))), 200);
    // An image is not text: a data URL a megabyte long says nothing about how many tokens the prompt is.
    assert.equal(textTokensAtLeast(chat([{ type: 'text', text: 'x'.repeat(50) }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1_000_000)}` } }])), 10);
    assert.equal(textTokensAtLeast({ model: 'e', input: ['abcde', 'fghij'] }), 2);
    assert.equal(textTokensAtLeast({ model: 'e', input: 'abcdefghij' }), 2);
    assert.equal(textTokensAtLeast({}), 0);
  });

  it('leaves out a node whose listed context the prompt is clearly beyond, only when another fits', () => {
    const small = { offer: { context: 8_192 }, name: 'small' }, big = { offer: { context: 131_072 }, name: 'big' };
    const long = chat('word '.repeat(10_000));
    assert.deepEqual(fitting(long, [small, big]).map((o) => o.name), ['big']);
    assert.deepEqual(fitting(chat('hi'), [small, big]).map((o) => o.name), ['small', 'big']);
    // Nothing fits: every node stays, and the model server says what it says, as before.
    assert.deepEqual(fitting(long, [small]).map((o) => o.name), ['small']);
  });
});
