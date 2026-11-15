import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Every host this package's code may name, and what for. A router or a node has no server of ours to call: the
// project's own domain is not on the list, and a host added to the code has to be added here, in the open.
const MAY_NAME: Record<string, string> = {
  '127.0.0.1': 'this computer: the router, the node, the model server',
  'api.mainnet-beta.solana.com': 'the default Solana RPC (--rpc sets another)',
  'registry.npmjs.org': 'doctor asks npm whether a newer release is out',
  'api.trustedservices.intel.com': 'Intel collateral, to verify a TDX enclave',
  'certificates.trustedservices.intel.com': 'Intel root certificate, to verify a TDX enclave',
  'kdsintf.amd.com': 'AMD key service, to verify an SEV-SNP enclave',
  'lite-api.jup.ag': 'a node that pledged a burn buys the token here',
  'your-node.example.com': 'the placeholder address provider init writes',
  host: 'a stand-in base for parsing a path',
  x: 'a stand-in base for parsing a path',
};

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
const SRC = new URL('../src/', import.meta.url).pathname;
/** host -> the files that name it, from every http(s) address written in the source. */
export function hostsNamed(sources: { path: string; text: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of sources) for (const m of s.text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) out.set(m[1], [...(out.get(m[1]) ?? []), s.path]);
  return out;
}

describe('the hosts this package can call', () => {
  const sources = files(SRC).map((path) => ({ path: path.slice(SRC.length), text: readFileSync(path, 'utf8') }));

  it('names only hosts on the list, each with a reason', () => {
    const named = hostsNamed(sources);
    const unlisted = [...named].filter(([h]) => !(h in MAY_NAME)).map(([h, where]) => `${h} (${[...new Set(where)].join(', ')})`);
    assert.deepEqual(unlisted, [], 'a host the code names has to be listed in this test, with what it is for');
    for (const h of Object.keys(MAY_NAME)) assert.ok(named.has(h), `${h} is on the list but no longer in the code: take it off`);
  });

  it('never names a host of the project itself: there is no server of ours for a router or a node to call', () => {
    const ours = [...hostsNamed(sources)].filter(([h]) => /orrery/i.test(h)).map(([h, where]) => `${h} (${where[0]})`);
    assert.deepEqual(ours, []);
    assert.ok(!Object.keys(MAY_NAME).some((h) => /orrery/i.test(h)));
  });

  it('catches an address added to the code', () => {
    const named = hostsNamed([{ path: 'x.ts', text: "await fetch('https://telemetry.orrerynode.com/v1/ping')" }]);
    assert.deepEqual([...named.keys()], ['telemetry.orrerynode.com']);
    assert.ok(!('telemetry.orrerynode.com' in MAY_NAME));
  });
});
