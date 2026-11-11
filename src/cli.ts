#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { compareClocks, runScenario, type Scenario } from './scenario.js';
import { Progress, progressFile } from './progress.js';
import type { Engine } from './clock.js';

const USAGE = `gamecheck run <scenario.json...> [options]    play one or more scenarios, stepped by default
gamecheck compare <scenario.json> [options]   play it on the real clock and the stepped one, and diff the results

  --url <page>          the page to test (overrides the scenario's)
  --engine raf|phaser   how to drive time (raf: any engine; phaser: steps Phaser.Game directly)
  --game-ref <expr>     phaser only: an expression for the Phaser.Game in the page, such as window.__GAME__
  --real                run: use the real clock
  --gpu                 draw on the real GPU (faster; software rendering stays the pixel reference)
  --no-render           phaser only: step with headlessStep, which skips drawing (fastest; camera-view values go stale)
  --headed              show the browser
  --terse               one summary line
  --json                full JSON result
  --progress            write live progress to .gamecheck/progress.json (or $GAMECHECK_PROGRESS) for a panel to show
  --progress-file <f>   write live progress to this file instead`;

const FLAGS = new Set(['real', 'gpu', 'noRender', 'headed', 'terse', 'json', 'help', 'progress']);

function parse(argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const next = argv[i + 1];
    if (FLAGS.has(key) || next === undefined || next.startsWith('--')) opt[key] = true;
    else { opt[key] = next; i += 1; }
  }
  return { pos, opt };
}

function load(file: string, opt: Record<string, string | true>): Scenario {
  const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario;
  if (typeof opt.url === 'string') scenario.url = opt.url;
  if (typeof opt.engine === 'string') scenario.engine = opt.engine as Engine;
  if (typeof opt.gameRef === 'string') scenario.gameRef = opt.gameRef;
  if (opt.noRender) scenario.render = false;
  return scenario;
}

async function main(): Promise<number> {
  const { pos, opt } = parse(process.argv.slice(2));
  const [command, ...files] = pos;
  if (!command || files.length === 0 || opt.help) { console.log(USAGE); return command ? 0 : 1; }
  const shared = { gpu: Boolean(opt.gpu), headed: Boolean(opt.headed) };
  if (command === 'compare') {
    const result = await compareClocks(load(files[0] ?? '', opt), shared);
    if (opt.json) console.log(JSON.stringify(result, null, 1));
    else console.log(`${result.equivalent ? 'EQUIVALENT' : 'DIFFERENT'} ${result.id}: real ${result.real.ok ? 'pass' : 'fail'} ${(result.real.ms / 1000).toFixed(1)} s, stepped ${result.stepped.ok ? 'pass' : 'fail'} ${(result.stepped.ms / 1000).toFixed(1)} s${result.differences.length ? `\n  ${result.differences.join('\n  ')}` : ''}`);
    return result.equivalent ? 0 : 1;
  }
  if (command === 'run') {
    const target = progressFile(typeof opt.progressFile === 'string' ? opt.progressFile : opt.progress);
    const progress = target ? new Progress({ file: target, total: files.length, label: `gamecheck run${opt.real ? ' (real clock)' : ''}` }) : undefined;
    let allOk = true;
    try {
      for (const file of files) {
        const scenario = load(file, opt);
        progress?.begin(scenario);
        const record = await runScenario(scenario, { ...shared, stepped: !opt.real }, progress);
        const failed = record.observations.filter((one) => !one.ok).map((one) => `${one.why}: got ${JSON.stringify(one.actual)}`);
        progress?.end({ id: record.id, ok: record.ok, ms: record.ms, why: record.error ?? failed[0] });
        allOk &&= record.ok;
        if (opt.json) console.log(JSON.stringify(record, null, 1));
        else console.log(`${record.ok ? 'ok  ' : 'FAIL'} ${record.id} (${record.clock}, ${(record.ms / 1000).toFixed(1)} s)${record.error ? `: ${record.error}` : ''}${opt.terse ? '' : failed.length ? `\n  ${failed.join('\n  ')}` : ''}`);
      }
    } finally {
      progress?.finish();
    }
    return allOk ? 0 : 1;
  }
  console.log(USAGE);
  return 1;
}

main().then((code) => process.exit(code), (error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
