import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { releaseLine, versionLine } from '../src/provider/check.ts';

describe('provider check: which release the node runs', () => {
  it('tells a node running an older release to start again on the newest', () => {
    assert.deepEqual(versionLine({ running: '0.1.26', here: '0.1.27', latest: '0.1.27' }), { ok: null, what: 'version', detail: 'the running node is 0.1.26; 0.1.27 is on npm: stop it and start it again with npx -y orrery-node@latest provider start --config …' });
  });

  it('says a node is on the latest, or ahead of npm', () => {
    assert.deepEqual(versionLine({ running: '0.1.27', here: '0.1.27', latest: '0.1.27' }), { ok: true, what: 'version', detail: 'the running node is 0.1.27, the latest on npm' });
    assert.equal(versionLine({ running: '0.1.28', here: '0.1.28', latest: '0.1.27' }).detail, 'the running node is 0.1.28, ahead of npm (0.1.27)');
  });

  it('with no node running, goes by the release this command would start, and says when npm did not answer', () => {
    assert.equal(versionLine({ running: null, here: '0.1.26', latest: '0.1.27' }).detail, '0.1.26; 0.1.27 is on npm: start it with npx -y orrery-node@latest provider start --config …');
    assert.deepEqual(versionLine({ running: null, here: '0.1.27', latest: null }), { ok: null, what: 'version', detail: '0.1.27; npm did not answer' });
  });

  it('provider status says a running node is older than the release installed here, without asking npm', () => {
    assert.equal(releaseLine('0.1.26', '0.1.27', 'orrery provider start --config provider.json'), '  release               0.1.26 is running; 0.1.27 is installed here: stop the node and start it again to run 0.1.27 (orrery provider start --config provider.json)');
    assert.equal(releaseLine('0.1.27', '0.1.27', 'x'), null);
    assert.equal(releaseLine('0.1.28', '0.1.27', 'x'), null);
    assert.equal(releaseLine(undefined, '0.1.27', 'x'), null);
    assert.equal(releaseLine('0.1.26', null, 'x'), null);
  });
});
