import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProviderConfig } from './node.ts';

/** provider.json, read for any provider command. A missing file or broken JSON is said with what to do, instead of
 * Node's ENOENT or the JSON parser's message on its own: most often the path is off, or a hand edit left a comma. */
export function readProviderConfig(path: string, given: string, cli: string): ProviderConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const full = resolve(path);
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`there is no ${given}${full === given ? '' : ` here (looked at ${full})`}. Write one with: ${cli} provider init, or pass --config with the file it wrote`);
    if ((e as NodeJS.ErrnoException).code === 'EISDIR') throw new Error(`${given} is a folder; --config takes the provider.json file inside it`);
    throw e;
  }
  try {
    return JSON.parse(text) as ProviderConfig;
  } catch (e) {
    throw new Error(`${given} is not valid JSON: ${(e as Error).message.replace(/^Unexpected/, 'unexpected')}. Fix it there, or write a fresh one with: ${cli} provider init --force`);
  }
}
