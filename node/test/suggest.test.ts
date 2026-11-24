import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nearest, unknownCommand } from '../src/suggest.ts';
import { COMMANDS, PROVIDER_COMMANDS } from '../src/suggest.ts';

describe('a mistyped command', () => {
  it('is answered with the nearest command when it is close enough', () => {
    assert.equal(unknownCommand('provder', 'orrery'), 'there is no orrery provder. Did you mean orrery provider? orrery --help lists every command');
    assert.equal(unknownCommand('strat', 'orrery', 'provider'), 'there is no orrery provider strat. Did you mean orrery provider start? orrery --help lists every command');
    assert.equal(nearest('docter', COMMANDS), 'doctor');
    assert.equal(nearest('stauts', PROVIDER_COMMANDS), 'status');
    assert.equal(nearest('regsiter', PROVIDER_COMMANDS), 'register');
  });

  it('suggests nothing for a word that is not near any command', () => {
    assert.equal(unknownCommand('deploy', 'orrery'), 'there is no orrery deploy. orrery --help lists every command');
    assert.equal(nearest('xyz', COMMANDS), null);
  });
});
