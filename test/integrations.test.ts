import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const body = (text: string): string => text.replace(/^\/\/ .*\n/gm, '').replace(/\/\/# sourceMappingURL=.*\n?/g, '').trim();

for (const name of ['progress', 'lean']) {
  test(`integrations/${name}.mjs is the compiled src/${name}.ts, so a harness that copies it gets the real thing`, () => {
    const copy = readFileSync(join(root, 'integrations', `${name}.mjs`), 'utf8');
    const built = readFileSync(join(root, 'dist', 'src', `${name}.js`), 'utf8');
    assert.equal(body(copy), body(built), `run: npm run build && node scripts/sync-integrations.mjs`);
    assert.doesNotMatch(copy, /from '\.\.?\//, 'no imports of other gamecheck files');
  });
}
