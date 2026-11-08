import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newer, render, versionCheck } from '../src/doctor.ts';

describe('orrery doctor version line', () => {
  it('compares dotted versions', () => {
    assert.ok(newer('0.1.4', '0.1.5'));
    assert.ok(newer('0.1.9', '0.2.0'));
    assert.ok(!newer('0.1.5', '0.1.5'));
    assert.ok(!newer('0.1.10', '0.1.9'));
  });

  it('points to the newer release, or says this one is current', () => {
    assert.match(render([versionCheck('0.1.4', '0.1.5')]), /· version\s+0\.1\.4; 0\.1\.5 is on npm: npx -y orrery-node@latest/);
    assert.match(render([versionCheck('0.1.5', '0.1.5')]), /✓ version\s+0\.1\.5, the latest on npm/);
    assert.match(render([versionCheck('0.1.5', null)]), /· version\s+0\.1\.5; npm did not answer/);
    assert.match(render([versionCheck('0.1.5', '0.1.4')]), /✓ version\s+0\.1\.5, ahead of npm \(0\.1\.4\)/);
  });
});
