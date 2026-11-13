import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nameHeader } from '../src/router/server.ts';

describe('the node name an answer carries', () => {
  it('is the name as is when a header can carry it, percent-encoded when it cannot', () => {
    assert.equal(nameHeader('Orrery Seed'), 'Orrery Seed');
    assert.equal(nameHeader('Nœud Paris'), 'N%C5%93ud%20Paris');
    assert.equal(nameHeader('Evil\r\nx-orrery-cost: 0'), 'Evil%0D%0Ax-orrery-cost%3A%200');
    assert.equal(nameHeader('100% GPU'), '100%25%20GPU');
    assert.equal(nameHeader(undefined), '');
    assert.equal(nameHeader('x'.repeat(200)).length, 80);
  });
});
