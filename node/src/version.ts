import { readFileSync } from 'node:fs';

/** The orrery-node release this code is, from its own package.json (the same path from src/ and from dist/). */
export const PACKAGE_VERSION: string | null = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
})();
