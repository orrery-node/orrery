import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderRisk, folderWarning } from '../src/provider/folder.ts';

describe('where a node keeps what it is owed', () => {
  it('a temporary folder is called one, wherever the system keeps them', () => {
    const made = mkdtempSync(join(tmpdir(), 'orrery-folder-'));
    try {
      assert.equal(folderRisk(made, { container: false }), 'temporary');
      assert.equal(folderRisk(join(made, 'provider', 'data'), { container: false }), 'temporary', 'a folder not made yet, under a temporary one');
    } finally {
      rmSync(made, { recursive: true, force: true });
    }
    assert.equal(folderRisk('/srv/orrery', { tmp: ['/tmp'], container: false }), null);
    assert.equal(folderRisk('/tmpfiles/orrery', { tmp: ['/tmp'], container: false }), null, 'a name that only starts like one');
  });

  it('inside a container, only a mounted disk outlives the container', () => {
    assert.equal(folderRisk('/app/data', { tmp: [], container: true, onRootDisk: true }), 'container');
    assert.equal(folderRisk('/var/data/orrery', { tmp: [], container: true, onRootDisk: false }), null);
    assert.equal(folderRisk('/app/data', { tmp: [], container: false, onRootDisk: true }), null, 'a plain machine keeps its own disk');
  });

  it('says how much is at stake, and says nothing when the folder stays', () => {
    assert.match(folderWarning('/tmp/orrery', '0.031200', { tmp: ['/tmp'], container: false }) ?? '', /^\/tmp\/orrery is a temporary folder: a restart can wipe it, .*\(\$0\.031200 now\)\. Set dataDir to a folder that stays$/);
    assert.match(folderWarning('/app/data', '0.004000', { tmp: [], container: true, onRootDisk: true }) ?? '', /on this container's own disk: .*\(\$0\.004000 now\)\. Mount a disk there$/);
    assert.equal(folderWarning('/var/data/orrery', '0.004000', { tmp: [], container: true, onRootDisk: false }), null);
  });
});
