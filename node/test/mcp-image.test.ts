import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { imageType } from '../src/mcp.ts';

describe('orrery mcp image tool', () => {
  it('names each image by its first bytes: PNG, JPEG or WebP, and PNG when it cannot tell', () => {
    assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')), 'image/png');
    assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')), 'image/jpeg');
    assert.equal(imageType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64')), 'image/webp');
    assert.equal(imageType('AAAA'), 'image/png');
  });
});
