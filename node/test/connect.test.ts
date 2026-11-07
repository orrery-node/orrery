import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codexProfile, instructions } from '../src/connect.ts';

describe('orrery connect', () => {
  it('writes a Codex profile that points at the router over the Responses API', () => {
    const t = codexProfile('http://127.0.0.1:7171/', 'gpt-oss-120b');
    assert.ok(t.startsWith('model = "gpt-oss-120b"\nmodel_provider = "orrery"\n\n[model_providers.orrery]'));
    assert.match(t, /base_url = "http:\/\/127\.0\.0\.1:7171\/v1"\nwire_api = "responses"/);
  });

  it('keeps the top-level keys above the provider table', () => {
    const t = codexProfile('http://127.0.0.1:7171', 'm');
    assert.ok(t.indexOf('model_provider = ') < t.indexOf('[model_providers.orrery]'));
  });

  it('tells SDK clients the base URL and that any key works', () => {
    assert.match(instructions('openai', 'http://127.0.0.1:7171', 'm', ''), /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:7171\/v1/);
    assert.match(instructions('anthropic', 'http://127.0.0.1:7171', 'm', ''), /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:7171\n/);
    assert.match(instructions('codex', 'http://127.0.0.1:7171', 'm', '/h/orrery.config.toml'), /Save as \/h\/orrery\.config\.toml[\s\S]*codex --profile orrery/);
  });
});
