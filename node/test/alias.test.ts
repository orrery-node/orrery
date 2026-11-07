import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAlias, parseAliases, parseModel } from '../src/router/policy.ts';

describe('model aliases', () => {
  it('maps exact names and prefixes, and keeps a route suffix on the target', () => {
    const a = parseAliases('claude-*=llama-3.3-70b:cheap, gpt-4o=deepseek-v3');
    assert.deepEqual(a, [{ from: 'claude-', prefix: true, to: 'llama-3.3-70b:cheap' }, { from: 'gpt-4o', prefix: false, to: 'deepseek-v3' }]);
    assert.equal(applyAlias('claude-sonnet-4-5', a), 'llama-3.3-70b:cheap');
    assert.deepEqual(parseModel(applyAlias('claude-sonnet-4-5', a), 'auto'), { model: 'llama-3.3-70b', route: 'price' });
    assert.equal(applyAlias('gpt-4o', a), 'deepseek-v3');
    assert.equal(applyAlias('gpt-4o-mini', a), 'gpt-4o-mini');
    assert.equal(applyAlias('qwen3-235b', a), 'qwen3-235b');
  });

  it('rejects a pair without both sides and accepts nothing at all', () => {
    assert.throws(() => parseAliases('claude-*'), /from=to/);
    assert.throws(() => parseAliases('=llama'), /from=to/);
    assert.deepEqual(parseAliases(undefined), []);
    assert.deepEqual(parseAliases(''), []);
  });
});
