// Writes CHANGELOG.md from web/src/data/changelog.ts:  cd web && npx tsx scripts/changelog.mjs > ../CHANGELOG.md
import { changelogMarkdown } from '../src/data/changelog.ts';

process.stdout.write(changelogMarkdown());
