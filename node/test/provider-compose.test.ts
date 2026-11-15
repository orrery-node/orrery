import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeFile, upstreamInContainer } from '../src/provider/compose.ts';

const base = { configPath: '/srv/orrery/provider.json', home: '/home/op', pkg: 'orrery-node@0.1.17', port: 7272 };

describe('orrery provider compose', () => {
  it('runs the package from npm in the official image, with the config and the node’s folder at their own paths', () => {
    const y = composeFile({ ...base, cfg: { listen: 7272, upstream: { baseUrl: 'http://gpu-box:8000/v1' } } });
    assert.match(y, /^services:\n {2}node:\n {4}image: node:22-slim\n {4}command: "npx -y --package=orrery-node@0\.1\.17 orrery provider start --config \/srv\/orrery\/provider\.json"\n {4}restart: unless-stopped$/m);
    assert.match(y, /- "7272:7272"/);
    assert.match(y, /- "\/srv\/orrery\/provider\.json:\/srv\/orrery\/provider\.json:ro"/);
    assert.match(y, /- "\/home\/op\/\.orrery\/provider:\/home\/op\/\.orrery\/provider"/);
    assert.match(y, /- "HOME=\/home\/op"/);
    assert.ok(!y.includes('host.docker.internal'), 'a model server on another machine is reached as is');
  });

  it('reaches a model server on this computer through the host, and says so to the node', () => {
    const y = composeFile({ ...base, cfg: { dataDir: '~/node-data', upstream: { baseUrl: 'http://127.0.0.1:11434/v1' } } });
    assert.match(y, /- "ORRERY_UPSTREAM_URL=http:\/\/host\.docker\.internal:11434\/v1"/);
    assert.match(y, /extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"/);
    assert.match(y, /- "\/home\/op\/node-data:\/home\/op\/node-data"/);
    assert.deepEqual(upstreamInContainer('http://localhost:8000/v1'), { url: 'http://host.docker.internal:8000/v1', viaHost: true });
    assert.deepEqual(upstreamInContainer('https://api.example.com/v1'), { url: 'https://api.example.com/v1', viaHost: false });
  });

  it('passes secrets by name and never mounts the wallet', () => {
    const y = composeFile({ ...base, cfg: { nodeKeyEnv: 'ORRERY_NODE_KEY', upstream: { baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'UPSTREAM_KEY' }, ...({ wallet: '/home/op/wallet.json' } as object) } });
    assert.match(y, /\n {6}- ORRERY_NODE_KEY\n {6}- UPSTREAM_KEY\n/);
    assert.ok(!y.includes('wallet.json'), 'the wallet stays out of the container');
  });

  it('brings a node key kept outside the node’s folder, read-only', () => {
    const y = composeFile({ ...base, cfg: { nodeKey: '/etc/orrery/node.json', upstream: { baseUrl: 'http://gpu-box:8000/v1' } } });
    assert.match(y, /- "\/etc\/orrery\/node\.json:\/etc\/orrery\/node\.json:ro"/);
    const inside = composeFile({ ...base, cfg: { nodeKey: '~/.orrery/provider/node.json', upstream: { baseUrl: 'http://gpu-box:8000/v1' } } });
    assert.equal((inside.match(/node\.json/g) ?? []).length, 0, 'a key inside the folder is already mounted with it');
  });

  it('gives the node its wallet’s address, since the wallet itself stays out of the container', () => {
    const y = composeFile({ ...base, cfg: { upstream: { baseUrl: 'http://gpu-box:8000/v1' } }, authority: 'Wa11etAddre55' });
    assert.match(y, /- "ORRERY_AUTHORITY=Wa11etAddre55"/);
    assert.ok(!/wallet\.json/.test(y), 'the wallet file is not mounted');
    assert.ok(!composeFile({ ...base, cfg: { upstream: { baseUrl: 'http://gpu-box:8000/v1' } } }).includes('ORRERY_AUTHORITY'));
  });
});
