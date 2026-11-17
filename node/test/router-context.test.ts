import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitting, textTokensAtLeast, tooLong } from '../src/router/context.ts';

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

  it('says when a prompt is clearly longer than every node lists, in the words OpenAI and Anthropic clients act on', () => {
    const small = { offer: { context: 8_192 } }, big = { offer: { context: 131_072 } };
    const long = chat('word '.repeat(10_000));
    assert.deepEqual(tooLong(long, [small]), { floor: 10_000, largest: 8_192, openai: "This model's maximum context length is 8192 tokens. However, your messages resulted in at least 10000 tokens. Please reduce the length of the messages.", anthropic: 'prompt is too long: 10000 tokens > 8192 maximum' });
    assert.equal(tooLong(long, [small, big]), null);
    assert.equal(tooLong(chat('hi'), [small]), null);
    // A node that lists no context is not measured against.
    assert.equal(tooLong(long, [small, { offer: { context: 0 } }]), null);
  });
});
