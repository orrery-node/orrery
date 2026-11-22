import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codexProfile, contextFromRouter, instructions, opencodeConfig, routerNote } from '../src/connect.ts';

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
    assert.match(instructions('claude', 'http://127.0.0.1:7171', 'gpt-oss-120b', ''), /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:7171 ANTHROPIC_API_KEY=orrery claude\n[\s\S]*--alias 'claude-\*=gpt-oss-120b'/);
    assert.match(instructions('codex', 'http://127.0.0.1:7171', 'm', '/h/orrery.config.toml'), /Save as \/h\/orrery\.config\.toml[\s\S]*codex --profile orrery/);
  });

  it('writes an opencode provider for the router, starting on the model, with the agent header only when asked', () => {
    const c = JSON.parse(opencodeConfig('http://127.0.0.1:7171/', 'gpt-oss-120b'));
    assert.equal(c.model, 'orrery/gpt-oss-120b');
    assert.deepEqual(c.providers.orrery, { name: 'Orrery', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://127.0.0.1:7171/v1' }, models: { 'gpt-oss-120b': { name: 'gpt-oss-120b on Orrery' } } });
    assert.deepEqual(JSON.parse(opencodeConfig('http://127.0.0.1:7171', 'm', 'coder')).providers.orrery.headers, { 'x-orrery-agent': 'coder' });
    assert.match(instructions('opencode', 'http://127.0.0.1:7171', 'm', ''), /^Save as opencode\.jsonc[\s\S]*\n\nThen: opencode   \(it starts on orrery\/m; \/models lists it\)$/);
  });

  it('gives aider its base, a key and the openai/ model on one line', () => {
    assert.equal(instructions('aider', 'http://127.0.0.1:7171/', 'gpt-oss-120b', '').split('\n')[0], 'OPENAI_API_BASE=http://127.0.0.1:7171/v1 OPENAI_API_KEY=orrery aider --model openai/gpt-oss-120b');
    assert.equal(instructions('aider', 'http://127.0.0.1:7171', 'm', '', 'coder').split('\n')[0], 'OPENAI_API_BASE=http://127.0.0.1:7171/v1 OPENAI_API_KEY=agent/coder aider --model openai/m');
  });

  it('adds the context window when the router lists one, above the provider table', () => {
    const t = codexProfile('http://127.0.0.1:7171', 'm', 131072);
    assert.match(t, /model_provider = "orrery"\nmodel_context_window = 131072\n\n\[model_providers\.orrery\]/);
    assert.ok(!codexProfile('http://127.0.0.1:7171', 'm').includes('model_context_window'));
  });

  it('reads the context length from the router, and gives up quietly when it is not running', async () => {
    const up = async () => ({ ok: true, json: async () => ({ data: [{ id: 'a', context_length: 8192 }, { id: 'm', context_length: 131072 }] }) });
    assert.equal(await contextFromRouter('http://127.0.0.1:7171', 'm', up), 131072);
    assert.equal(await contextFromRouter('http://127.0.0.1:7171', 'x', up), undefined);
    assert.equal(await contextFromRouter('http://127.0.0.1:7171', 'm', async () => { throw new Error('ECONNREFUSED'); }), undefined);
  });

  it('says when no router answers at that address, and how to start one', () => {
    const withWallet = routerNote({ client: 'openai', router: 'http://127.0.0.1:7171/', models: null, model: 'gpt-oss-120b', asked: false, hasWallet: true }, 'orrery');
    assert.equal(withWallet, 'note: no router answers at http://127.0.0.1:7171 yet, so nothing will connect with these settings. Start one first: orrery router');
    const noWallet = routerNote({ client: 'mcp', router: 'http://127.0.0.1:7171', models: null, model: 'gpt-oss-120b', asked: false, hasWallet: false }, 'orrery');
    assert.match(noWallet ?? '', /Start one first: orrery wallet new {3}\(makes the wallet that pays; send it SOL and USDC\), then orrery router$/);
  });

  it('says nothing when the router lists the model the settings name', () => {
    assert.equal(routerNote({ client: 'openai', router: 'http://127.0.0.1:7171', models: [{ id: 'gpt-oss-120b' }, { id: 'b' }], model: 'gpt-oss-120b', asked: false, hasWallet: true }), null);
    assert.equal(routerNote({ client: 'claude', router: 'http://127.0.0.1:7171', models: [{ id: 'b' }], model: 'b', asked: true, hasWallet: false }), null);
  });

  it('says when a model asked for is not listed, and what is', () => {
    const n = routerNote({ client: 'openai', router: 'http://127.0.0.1:7171', models: [{ id: 'a' }, { id: 'b' }, {}], model: 'nope-1', asked: true, hasWallet: true });
    assert.equal(n, 'note: your router does not list nope-1 right now, so requests for it will not be answered. It lists: a, b');
    const many = routerNote({ client: 'openai', router: 'http://127.0.0.1:7171', models: 'abcdefgh'.split('').map((id) => ({ id })), model: 'nope-1', asked: true, hasWallet: true });
    assert.match(many ?? '', /It lists: a, b, c, d, e, f and 2 more$/);
  });

  it('says when it named another model because the usual one is not on the network', () => {
    const n = routerNote({ client: 'openai', router: 'http://127.0.0.1:7171', models: [{ id: 'llama-3.3-70b' }], model: 'llama-3.3-70b', asked: false, hasWallet: true });
    assert.equal(n, 'note: gpt-oss-120b is not on the network right now, so these settings name llama-3.3-70b, which your router lists.');
  });

  it('says when the router is up but has found no node; an MCP client is told only what concerns it', () => {
    assert.match(routerNote({ client: 'openai', router: 'http://127.0.0.1:7171', models: [], model: 'gpt-oss-120b', asked: false, hasWallet: true }, 'orrery') ?? '', /^note: your router answers at http:\/\/127\.0\.0\.1:7171 but lists no model yet: it has found no node that answers\. orrery doctor shows what it sees\.$/);
    assert.equal(routerNote({ client: 'mcp', router: 'http://127.0.0.1:7171', models: [{ id: 'a' }], model: 'nope-1', asked: true, hasWallet: true }), null);
  });

  it('with --agent, every client’s settings make its requests as that agent; without it, nothing changes', () => {
    const r = 'http://127.0.0.1:7171', p = '/home/me/.codex/orrery.config.toml';
    assert.match(instructions('openai', r, 'm', p, 'coder'), /^OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:7171\/v1\nOPENAI_API_KEY=agent\/coder   # every request goes as agent coder, held to the router's --agent-cap for it\n/);
    assert.match(instructions('anthropic', r, 'm', p, 'coder'), /\nANTHROPIC_API_KEY=agent\/coder   # every request goes as agent coder/);
    assert.match(instructions('claude', r, 'm', p, 'coder'), /^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:7171 ANTHROPIC_API_KEY=agent\/coder claude\n[\s\S]*\nEvery request goes as agent coder, held to the router's --agent-cap for it\.$/);
    assert.equal(instructions('mcp', r, 'm', p, 'coder'), 'Command for an MCP client: npx -y orrery-node mcp --router http://127.0.0.1:7171 --agent coder\nClaude Code: claude mcp add orrery -- npx -y orrery-node mcp --router http://127.0.0.1:7171 --agent coder');
    assert.match(codexProfile(r, 'm', 8192, 'coder'), /\nwire_api = "responses"\nhttp_headers = \{ "x-orrery-agent" = "coder" \}\n$/);
    assert.match(instructions('codex', r, 'm', p, 'coder'), /orrery connect codex --write --agent coder\)/);
    assert.doesNotMatch(codexProfile(r, 'm', 8192), /http_headers/);
    assert.match(instructions('openai', r, 'm', p), /\nOPENAI_API_KEY=orrery   # any value; the router has no key\n/);
  });
});
