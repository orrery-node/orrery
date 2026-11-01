// Copy the latest local rehearsal (node/devtools/e2e.ts) into the site. The site never invents these numbers.
import { readFileSync, writeFileSync } from 'node:fs';
const src = new URL('../../.local/e2e/summary.json', import.meta.url);
const out = new URL('../src/data/rehearsal.json', import.meta.url);
const s = JSON.parse(readFileSync(src, 'utf8'));
writeFileSync(out, JSON.stringify(s, null, 2) + '\n');
console.log(`rehearsal ${s.ranAt}: ${s.requests} requests, ${s.checks.filter((c) => c.ok).length}/${s.checks.length} checks`);
