import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProviderConfig } from '../src/provider/config-file.ts';

describe('provider.json that cannot be read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-cfg-'));

  it('a missing file says where it looked and how to make one', () => {
    assert.throws(() => readProviderConfig(join(dir, 'nope.json'), 'nope.json', 'orrery'), (e: Error) => e.message === `there is no nope.json here (looked at ${join(dir, 'nope.json')}). Write one with: orrery provider init, or pass --config with the file it wrote`);
  });

  it('says the path once when it was given whole', () => {
    const p = join(dir, 'gone.json');
    assert.throws(() => readProviderConfig(p, p, 'orrery'), (e: Error) => e.message === `there is no ${p}. Write one with: orrery provider init, or pass --config with the file it wrote`);
  });

  it('a folder says to pass the file inside it', () => {
    assert.throws(() => readProviderConfig(dir, 'node-folder', 'orrery'), /^Error: node-folder is a folder; --config takes the provider\.json file inside it$/);
  });

  it('broken JSON says it is not valid JSON, where, and how to start over', () => {
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{\n  "name": "x",\n}\n');
    assert.throws(() => readProviderConfig(p, 'broken.json', 'orrery'), (e: Error) => /^broken\.json is not valid JSON: .+\. Fix it there, or write a fresh one with: orrery provider init --force$/.test(e.message));
  });

  it('a good file reads as before', () => {
    const p = join(dir, 'good.json');
    writeFileSync(p, JSON.stringify({ name: 'Good Node', listen: 7288 }));
    assert.deepEqual(readProviderConfig(p, 'good.json', 'orrery'), { name: 'Good Node', listen: 7288 });
  });
});
