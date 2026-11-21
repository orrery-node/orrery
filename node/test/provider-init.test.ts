import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE_REPORTING, draftConfig, draftWallet, findUpstream, isEmbeddingModel, isRerankModel, isSpeechModel, networkId, nextSteps, walletNote } from '../src/provider/init.ts';

const fake = (served: Record<string, string[]>) => async (url: string) => {
  const base = url.replace(/\/models$/, '');
  if (!served[base]) throw new Error('ECONNREFUSED');
  return { ok: true, json: async () => ({ data: served[base].map((id) => ({ id })) }) };
};

describe('orrery provider init', () => {
  it('lists the steps from a fresh config to a running node, check and Docker included', () => {
    const steps = nextSteps('provider.json');
    assert.match(steps, /1\. .*publicUrl.*\n {2}2\. .*provider compare.*\n {2}3\. .*provider register.*\n {2}4\. .*provider check.*\n {2}5\. .*provider start.*provider compose/s);
  });

  it('turns upstream ids into network-style ids', () => {
    assert.equal(networkId('llama3.1:8b'), 'llama3.1-8b');
    assert.equal(networkId('Qwen/Qwen3-32B'), 'qwen3-32b');
    assert.equal(networkId('meta-llama/llama-3.3-70b-instruct'), 'llama-3.3-70b-instruct');
  });

  it('finds the first known local server that lists models, or the one given', async () => {
    const f = await findUpstream(undefined, fake({ 'http://127.0.0.1:8000/v1': ['Qwen/Qwen3-32B'] }));
    assert.deepEqual(f, { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['Qwen/Qwen3-32B'] });
    const g = await findUpstream('http://10.0.0.5:9000/v1/', fake({ 'http://10.0.0.5:9000/v1': ['m1'] }));
    assert.equal(g.baseUrl, 'http://10.0.0.5:9000/v1');
    await assert.rejects(findUpstream(undefined, fake({})), /pass --upstream/);
  });

  it('says what to do next when no model server is running, and when one is running with no models yet', async () => {
    await assert.rejects(findUpstream(undefined, fake({})), /no model server answered on this computer.*Start one and run this again.*ollama pull llama3\.1:8b.*--upstream <url>/s);
    await assert.rejects(findUpstream(undefined, fake({ 'http://127.0.0.1:11434/v1': [] })), /^Error: Ollama answered at http:\/\/127\.0\.0\.1:11434\/v1 but has no models yet\. Pull one \(ollama pull llama3\.1:8b\) and run this again/);
    await assert.rejects(findUpstream(undefined, fake({ 'http://127.0.0.1:1234/v1': [] })), /^Error: LM Studio answered at http:\/\/127\.0\.0\.1:1234\/v1 but has no models yet\. Load one in it and run this again/);
    // A server further down the list that does have models still wins over an empty one.
    assert.equal((await findUpstream(undefined, fake({ 'http://127.0.0.1:11434/v1': [], 'http://127.0.0.1:8000/v1': ['Qwen/Qwen3-32B'] }))).name, 'vLLM');
    await assert.rejects(findUpstream('http://10.0.0.5:9000/v1', fake({ 'http://10.0.0.5:9000/v1': [] })), /your server answered at http:\/\/10\.0\.0\.5:9000\/v1 but has no models yet/);
  });

  it('drafts a config with every model at a placeholder price', () => {
    const c = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b', 'qwen2.5:7b'] }, { name: 'Basement GPU' });
    assert.equal(c.name, 'Basement GPU');
    assert.deepEqual(c.upstream, { baseUrl: 'http://127.0.0.1:11434/v1' });
    assert.deepEqual(c.models.map((m) => [m.id, m.upstreamModel, m.price.input, m.price.output]), [['llama3.1-8b', 'llama3.1:8b', 500_000, 1_000_000], ['qwen2.5-7b', 'qwen2.5:7b', 500_000, 1_000_000]]);
  });

  it('a new node lists payment inside in its price list from its first registration, so routers keep to it from their first request', () => {
    const c = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b'] });
    assert.equal(c.paymentInside, true);
  });

  it('gives a server that reports cache hits a cached-input price, and leaves the others at the input price', () => {
    const v = draftConfig({ name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['Qwen/Qwen3-32B'] });
    assert.equal(v.models[0].price.cachedInput, 125_000);
    const o = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b'] });
    assert.equal('cachedInput' in o.models[0].price, false);
    assert.equal(CACHE_REPORTING.vLLM, '--enable-prompt-tokens-details');
    assert.equal(CACHE_REPORTING.SGLang, '--enable-cache-report');
  });

  it('prices embedding models on input tokens only', () => {
    for (const id of ['BAAI/bge-m3', 'intfloat/e5-large-v2', 'nomic-embed-text', 'mxbai-embed-large', 'text-embedding-3-small', 'Snowflake/snowflake-arctic-embed-l']) assert.ok(isEmbeddingModel(id), id);
    for (const id of ['Qwen/Qwen3-32B', 'llama3.1:8b', 'deepseek-v3', 'gemma-3-27b']) assert.ok(!isEmbeddingModel(id), id);
    const c = draftConfig({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['nomic-embed-text', 'llama3.1:8b'] });
    assert.deepEqual(c.models.map((m) => [m.id, m.price.input, m.price.output]), [['nomic-embed-text', 20_000, 0], ['llama3.1-8b', 500_000, 1_000_000]]);
  });

  it('lists rerankers as "kind": "rerank" and embedding models as "kind": "embeddings", telling a reranker from the embedder it shares a name with', () => {
    for (const id of ['BAAI/bge-reranker-v2-m3', 'mixedbread-ai/mxbai-rerank-large-v1', 'jinaai/jina-reranker-v2-base-multilingual', 'Qwen/Qwen3-Reranker-4B']) assert.ok(isRerankModel(id) && !isEmbeddingModel(id), id);
    for (const id of ['BAAI/bge-m3', 'mxbai-embed-large', 'Qwen/Qwen3-32B']) assert.ok(!isRerankModel(id), id);
    const c = draftConfig({ name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['BAAI/bge-reranker-v2-m3', 'BAAI/bge-m3', 'Qwen/Qwen3-32B'] });
    assert.deepEqual(c.models.map((m) => [m.id, m.kind ?? 'chat', m.price.output]), [['bge-reranker-v2-m3', 'rerank', 0], ['bge-m3', 'embeddings', 0], ['qwen3-32b', 'chat', 1_000_000]]);
  });

  it('lists text-to-speech models as "kind": "speech", billed on input only, and nothing else as speech', () => {
    for (const id of ['hexgrad/Kokoro-82M', 'kokoro', 'rhasspy/piper-voices', 'canopylabs/orpheus-3b-0.1-ft', 'ResembleAI/chatterbox', 'coqui/XTTS-v2', 'gpt-4o-mini-tts']) assert.ok(isSpeechModel(id) && !isEmbeddingModel(id) && !isRerankModel(id), id);
    for (const id of ['Qwen/Qwen3-32B', 'llama3.1:8b', 'BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3', 'deepseek-v3']) assert.ok(!isSpeechModel(id), id);
    const c = draftConfig({ name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['hexgrad/Kokoro-82M', 'Qwen/Qwen3-32B'] });
    assert.deepEqual(c.models.map((m) => [m.id, m.kind ?? 'chat', m.price.input, m.price.output]), [['kokoro-82m', 'speech', 2_000_000, 0], ['qwen3-32b', 'chat', 500_000, 1_000_000]]);
  });

  it('names a wallet the operator has: the one orrery wallet new made, else the usual Solana file, else where wallet new will put one', () => {
    const h = '/h/.orrery/wallet.json';
    assert.equal(draftWallet({ home: h, homeExists: true, solanaExists: true }), h);
    assert.equal(draftWallet({ home: h, homeExists: false, solanaExists: true }), '~/.config/solana/id.json');
    assert.equal(draftWallet({ home: h, homeExists: false, solanaExists: false }), h);
    assert.equal(draftWallet({ asked: '/k/mine.json', home: h, homeExists: true, solanaExists: true }), '/k/mine.json');
  });

  it('says which address the node will be listed under, or how to get a wallet when the file is not there', () => {
    assert.equal(walletNote({ wallet: '/h/.orrery/wallet.json', exists: true, isHome: true, out: 'provider.json', address: 'Addr111' }, 'orrery'),
      'the node will be listed under Addr111, the wallet at /h/.orrery/wallet.json. It signs once, for provider register.');
    assert.equal(walletNote({ wallet: '/h/.orrery/wallet.json', exists: false, isHome: true, out: 'provider.json' }, 'orrery'),
      'note: there is no wallet at /h/.orrery/wallet.json yet. orrery wallet new makes one there. Or point "wallet" in provider.json at a Solana wallet you have, or put its address in "authority".');
    assert.match(walletNote({ wallet: '/k/mine.json', exists: false, isHome: false, out: 'provider.json' }, 'orrery'), /yet\. orrery wallet new --out \/k\/mine\.json makes one there\./);
  });

  it('asks for no second keypair file at the register step: the config names the wallet', () => {
    const steps = nextSteps('provider.json');
    assert.ok(!steps.includes('<keypair.json>'), steps);
    assert.match(steps, /\n {2}3\. orrery provider register --config provider\.json lists the node on chain \(one transaction from the wallet named in provider\.json\)\n/);
  });

  it('asks only for what is still missing: a public address given to init is not asked for again', () => {
    const given = nextSteps('provider.json', 'orrery', { publicUrl: 'https://gpu.example.org' });
    assert.match(given, /^ {2}1\. check your prices in provider\.json \(micro-USDC per million tokens; 500000 = \$0\.50\); routers will reach the node at https:\/\/gpu\.example\.org\n/);
    assert.ok(!given.includes('set publicUrl'), given);
    assert.match(nextSteps('provider.json'), /^ {2}1\. set publicUrl to an address routers can reach, and your prices/);
    assert.match(nextSteps('provider.json', 'orrery', { publicUrl: 'https://your-node.example.com' }), /^ {2}1\. set publicUrl/);
  });

  it('says, for an address only your own network reaches on a public cluster, to change it before listing', () => {
    const lan = nextSteps('provider.json', 'orrery', { publicUrl: 'http://192.168.1.20:7272' });
    assert.equal(lan.split('\n')[0], '  1. set publicUrl to a public domain or IP with this node’s port open: http://192.168.1.20:7272 reaches only machines on your own network (step 3 with --private-address lists it there alone), and check your prices (micro-USDC per million tokens; 500000 = $0.50)');
    const local = nextSteps('provider.json', 'orrery', { publicUrl: 'http://127.0.0.1:7272', localCluster: true } as Parameters<typeof nextSteps>[2]);
    assert.match(local, /^ {2}1\. check your prices in provider\.json .*routers will reach the node at http:\/\/127\.0\.0\.1:7272$/m, 'a local validator: as before');
  });

  it('writes the RPC it was given (--rpc or ORRERY_RPC_URL) into provider.json, and mainnet’s public one otherwise', () => {
    const found = { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.1:8b'] };
    assert.equal((draftConfig(found, { rpcUrl: 'https://my-rpc.example.com' } as Parameters<typeof draftConfig>[1]) as { rpcUrl: string }).rpcUrl, 'https://my-rpc.example.com');
    assert.equal(draftConfig(found).rpcUrl, 'https://api.mainnet-beta.solana.com');
  });
});
