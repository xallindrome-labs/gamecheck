#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { compareClocks, runScenario, type Scenario } from './scenario.js';
import type { Engine } from './clock.js';

const USAGE = `gamecheck run <scenario.json> [options]       play a scenario, stepped by default
gamecheck compare <scenario.json> [options]   play it on the real clock and the stepped one, and diff the results

  --url <page>          the page to test (overrides the scenario's)
  --engine raf|phaser   how to drive time (raf: any engine; phaser: steps Phaser.Game directly)
  --game-ref <expr>     phaser only: an expression for the Phaser.Game in the page, such as window.__GAME__
  --real                run: use the real clock
  --gpu                 draw on the real GPU (faster; software rendering stays the pixel reference)
  --headed              show the browser
  --terse               one summary line
  --json                full JSON result`;

function parse(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opt[key] = true;
    else { opt[key] = next; i += 1; }
  }
  return { pos, opt };
}

async function main(): Promise<number> {
  const { pos, opt } = parse(process.argv.slice(2));
  const [command, file] = pos;
  if (!command || !file || opt.help) { console.log(USAGE); return command ? 0 : 1; }
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;
  if (typeof opt.url === 'string') scenario.url = opt.url;
  if (typeof opt.engine === 'string') scenario.engine = opt.engine as Engine;
  if (typeof opt.gameRef === 'string') scenario.gameRef = opt.gameRef;
  const shared = { gpu: Boolean(opt.gpu), headed: Boolean(opt.headed) };
  if (command === 'compare') {
    const result = await compareClocks(scenario, shared);
    if (opt.json) console.log(JSON.stringify(result, null, 1));
    else console.log(`${result.equivalent ? 'EQUIVALENT' : 'DIFFERENT'} ${result.id}: real ${result.real.ok ? 'pass' : 'fail'} ${(result.real.ms / 1000).toFixed(1)} s, stepped ${result.stepped.ok ? 'pass' : 'fail'} ${(result.stepped.ms / 1000).toFixed(1)} s${result.differences.length ? `\n  ${result.differences.join('\n  ')}` : ''}`);
    return result.equivalent ? 0 : 1;
  }
  if (command === 'run') {
    const record = await runScenario(scenario, { ...shared, stepped: !opt.real });
    if (opt.json) console.log(JSON.stringify(record, null, 1));
    else {
      const failed = record.observations.filter((one) => !one.ok).map((one) => `${one.why}: got ${JSON.stringify(one.actual)}`);
      console.log(`${record.ok ? 'ok  ' : 'FAIL'} ${record.id} (${record.clock}, ${(record.ms / 1000).toFixed(1)} s)${record.error ? `: ${record.error}` : ''}${opt.terse ? '' : failed.length ? `\n  ${failed.join('\n  ')}` : ''}`);
    }
    return record.ok ? 0 : 1;
  }
  console.log(USAGE);
  return 1;
}

main().then((code) => process.exit(code), (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
