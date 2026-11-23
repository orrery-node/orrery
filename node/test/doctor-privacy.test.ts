import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { privacyLine } from '../src/doctor.ts';

describe('orrery doctor: one line on privacy', () => {
  it('counts how requests travel, where :private can go, and whether nodes see this computer', () => {
    const line = privacyLine([{ wire: true, inside: true, enclave: false }, { wire: true, inside: false, enclave: false }, { wire: false, inside: false, enclave: false }], false);
    assert.equal(line.what, 'privacy');
    assert.equal(line.ok, null);
    assert.equal(line.detail, '1 of 3 nodes take the request and the payment sealed to their own key, 1 the request only, 1 plain JSON inside TLS · none runs in an enclave this computer verified, so :private would find no node yet · no proxy, so nodes and the RPC see your address (orrery router --proxy socks5://127.0.0.1:9050 sends it all through Tor) · client IDs are dropped before anything leaves');
  });

  it('says where :private can go and that requests leave through the proxy', () => {
    const line = privacyLine([{ wire: true, inside: true, enclave: true }], true);
    assert.equal(line.detail, '1 of 1 node takes the request and the payment sealed to its own key · 1 runs in an enclave this computer verified, so :private has somewhere to go · requests leave through your proxy · client IDs are dropped before anything leaves');
  });

  it('with a router running, says how its sealed answers come back, as the router does', () => {
    const line = privacyLine([{ wire: true, inside: true, enclave: false }], true, { ms: 100, paced: 2, asked: 2 });
    assert.ok(line.detail.endsWith(' · requests leave through your proxy · sealed answers are asked for one 4 KiB frame every 100 ms; 2 of 2 nodes that answered sealed paced their answers · client IDs are dropped before anything leaves'));
  });
});
