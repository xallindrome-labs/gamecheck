// Refreshes integrations/*.mjs from the compiled sources. Run after `npm run build` whenever progress.ts or lean.ts changes.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = {
  progress: "Writes gamecheck's live progress file (the one the Claude Code panel shows).",
  lean: 'The lean launch options: a smaller canvas, lighter Chrome, low priority.',
  watchdog: "holdPriority (keeps every Chrome process at the priority you ask for) and watchMemory (kills Chrome past a memory ceiling). Both take a Playwright Browser. Needs lean.mjs beside it.",
};
for (const [name, note] of Object.entries(NOTES)) {
  const built = readFileSync(join(root, 'dist', 'src', `${name}.js`), 'utf8').replace(/\/\/# sourceMappingURL=.*\n?/g, '').replace("from './lean.js'", "from './lean.mjs'").trimEnd();
  const head = `// Standalone copy of gamecheck's src/${name}.ts, compiled, with no dependencies beyond Node.\n// ${note}\n// Copy it into your own harness. test/integrations.test.ts fails if it drifts from the source.\n`;
  writeFileSync(join(root, 'integrations', `${name}.mjs`), `${head}${built}\n`);
}
console.log('integrations refreshed');
