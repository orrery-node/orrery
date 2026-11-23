import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { latestOnNpm, versionCheck } from '../src/doctor.ts';
import { versionLine } from '../src/provider/check.ts';

describe('ORRERY_NO_UPDATE_CHECK: doctor and provider check without asking npm', () => {
  it('asks nothing of npm when it is 1', async () => {
    const real = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = (async () => { asked++; throw new Error('no network'); }) as typeof fetch;
    try {
      assert.equal(await latestOnNpm({ ORRERY_NO_UPDATE_CHECK: '1' }), 'off');
      assert.equal(asked, 0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('says the release was not checked, and how it was turned off', () => {
    assert.deepEqual(versionCheck('0.1.27', 'off'), { ok: null, what: 'version', detail: '0.1.27; not checked against npm (ORRERY_NO_UPDATE_CHECK=1)' });
    assert.deepEqual(versionLine({ running: '0.1.27', here: '0.1.27', latest: 'off' }), { ok: null, what: 'version', detail: 'the running node is 0.1.27; not checked against npm (ORRERY_NO_UPDATE_CHECK=1)' });
    assert.equal(versionLine({ running: null, here: '0.1.27', latest: 'off' }).detail, '0.1.27; not checked against npm (ORRERY_NO_UPDATE_CHECK=1)');
  });

  it('any other value leaves the check on', async () => {
    const real = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = (async () => { asked++; throw new Error('no network'); }) as typeof fetch;
    try {
      assert.equal(await latestOnNpm({ ORRERY_NO_UPDATE_CHECK: 'yes' }), null);
      assert.equal(asked, 1);
    } finally {
      globalThis.fetch = real;
    }
  });
});
