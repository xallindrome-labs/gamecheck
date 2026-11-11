import { Progress, progressFile } from './progress.js';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Interactive } from './interactive.js';
import { compareClocks, runScenario, type Scenario, type ScenarioRecord } from './scenario.js';

const scenarioInput = z.union([z.string(), z.record(z.string(), z.unknown())]).describe('A scenario object, or the path of a scenario JSON file');
const tuning = {
  lean: z.boolean().optional().describe('Logic checks only: a 640x360 window, lighter Chrome and low priority, so the PC stays usable. The smaller window only saves work for games that size their canvas to it; render:false and drawEvery are the big savings. Leave off for anything judged by what is on screen'),
  render: z.boolean().optional().describe('Phaser only: false skips drawing for the fastest steps; camera-view values and screenshots go stale'),
  drawEvery: z.number().int().min(1).optional().describe('Phaser only: draw one frame in N and step the rest without drawing. The last frame of each advance is always drawn'),
  priority: z.enum(['low', 'normal', 'high']).optional().describe('Chrome priority. low is the lean default; high is only above normal'),
  memoryMb: z.number().int().min(256).optional().describe("Ceiling on Chrome's total memory, checked once a second; past it the browser is killed and the run fails saying so"),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional().describe('Canvas size; the default is 1280x720, or 640x360 with lean'),
};
const shared = {
  scenario: scenarioInput,
  url: z.string().optional().describe("The page to test; overrides the scenario's own"),
  gpu: z.boolean().optional().describe('Draw on the real GPU: faster for logic checks, not for pixels'),
  ...tuning,
};
const tuned = ({ gpu, lean, render, drawEvery, priority, memoryMb, viewport }: { gpu?: boolean; lean?: boolean; render?: boolean; drawEvery?: number; priority?: 'low' | 'normal' | 'high'; memoryMb?: number; viewport?: { width: number; height: number } }) => ({ gpu, lean, render, drawEvery, priority, memoryMb, viewport });
const cleanly = <T extends object>(options: T): T => Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;

// An agent's tool call can be steered by what it read, so the server reads only scenario files and opens only web pages:
// a file: or other URL could hand a local file's contents back through state or a screenshot.
function webPage(url: string | undefined): string | undefined {
  if (url === undefined) return url;
  let protocol: string;
  try { protocol = new URL(url).protocol; } catch { throw new Error(`not a URL: ${url}`); }
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`gamecheck-mcp opens only http and https pages, not ${protocol} (use html for an inline page)`);
  return url;
}

function load(input: string | Record<string, unknown>, url?: string): Scenario {
  let scenario: Scenario;
  if (typeof input === 'string') {
    if (!input.toLowerCase().endsWith('.json')) throw new Error(`a scenario path must name a .json file: ${input}`);
    // JSON.parse's own error quotes the text it choked on; keep a file's contents out of the reply.
    try { scenario = JSON.parse(readFileSync(input, 'utf8')) as Scenario; } catch { throw new Error(`could not read a scenario from ${input}`); }
  } else scenario = input as unknown as Scenario;
  const loaded = url ? { ...scenario, url } : scenario;
  webPage(loaded.url);
  return loaded;
}

/** One line per result, so an agent spends few tokens; the full record only for what failed. */
function summary(record: ScenarioRecord): string {
  const failed = record.observations.filter((one) => !one.ok).map((one) => `${one.why}: got ${JSON.stringify(one.actual)}`);
  return `${record.ok ? 'ok' : 'FAIL'} ${record.id} (${record.clock}, ${(record.ms / 1000).toFixed(1)} s)${record.error ? `: ${record.error}` : ''}${failed.length ? `\n  ${failed.join('\n  ')}` : ''}`;
}

const server = new McpServer({ name: 'gamecheck', version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version });

server.registerTool('gamecheck_run', {
  description: 'Plays a game-check scenario in a headless browser, stepping the game by hand (fast and deterministic) unless real is set. Returns a short verdict and what failed.',
  inputSchema: { ...shared, real: z.boolean().optional().describe('Use the real clock instead of stepping the game') },
}, async ({ scenario, url, real, ...rest }) => {
  const loaded = load(scenario, url);
  const target = progressFile(undefined, { onByDefault: true });
  const progress = target ? new Progress({ file: target, total: 1, label: `gamecheck_run${rest.lean ? ' (lean)' : ''}` }) : undefined;
  progress?.begin(loaded);
  try {
    const record = await runScenario(loaded, { ...cleanly(tuned(rest)), stepped: !real }, progress);
    progress?.end({ id: record.id, ok: record.ok, ms: record.ms, why: record.error ?? record.observations.find((one) => !one.ok)?.why });
    return { content: [{ type: 'text' as const, text: summary(record) }], isError: !record.ok };
  } finally {
    progress?.finish();
  }
});

server.registerTool('gamecheck_compare', {
  description: 'Plays a scenario on the real clock and on the stepped one and lists every verdict or observed value that differs. Run it before trusting stepped results for a scenario.',
  inputSchema: shared,
}, async ({ scenario, url, ...rest }) => {
  const loaded = load(scenario, url);
  const target = progressFile(undefined, { onByDefault: true });
  const progress = target ? new Progress({ file: target, total: 1, label: 'gamecheck_compare (real clock, then stepped)' }) : undefined;
  progress?.begin(loaded);
  let result;
  try {
    result = await compareClocks(loaded, cleanly(tuned(rest)), progress);
    progress?.end({ id: result.id, ok: result.equivalent, ms: result.real.ms + result.stepped.ms, why: result.differences[0] });
  } finally {
    progress?.finish();
  }
  const text = `${result.equivalent ? 'EQUIVALENT' : 'DIFFERENT'} ${result.id}: real ${result.real.ok ? 'pass' : 'fail'} ${(result.real.ms / 1000).toFixed(1)} s, stepped ${result.stepped.ok ? 'pass' : 'fail'} ${(result.stepped.ms / 1000).toFixed(1)} s${result.differences.length ? `\n  ${result.differences.join('\n  ')}` : ''}`;
  return { content: [{ type: 'text' as const, text }], isError: !result.equivalent };
});

const game = new Interactive();
const json = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const exprs = z.record(z.string(), z.string()).describe('Named JavaScript expressions evaluated in the page, such as { "hp": "boss.hp" }');

server.registerTool('gamecheck_open', {
  description: 'Opens a game page for step-by-step play. Time stands still until you step it, so nothing happens between your calls. Holds the one-headless-run lock until gamecheck_close or 10 idle minutes. engine "raf" works with any engine and needs nothing from the game; engine "phaser" needs gameRef, an expression for the Phaser.Game.',
  inputSchema: {
    url: z.string().optional(), html: z.string().optional(),
    engine: z.enum(['raf', 'phaser']).default('raf'), gameRef: z.string().optional(),
    gpu: z.boolean().optional().describe('Faster rendering for logic checks; leave off for anything judged by pixels'),
    real: z.boolean().optional().describe('Run on the real clock instead of stepping'),
    ...tuning,
  },
}, async ({ url, html, engine, gameRef, real, ...rest }) => json(await game.open({ url: webPage(url), html, engine, gameRef, ...cleanly(tuned(rest)), stepped: !real })));

server.registerTool('gamecheck_step', {
  description: 'Advances game time and returns what happened. Give ms or frames, or until (an expression to wait for, with maxMs). inputs presses keys on the game clock: [{ key, atMs, holdMs }] with offsets from the start of the step. report is named expressions read before and after, and the result lists which changed, so you can check an input did something without a second call. Caps: 600000 ms per call and a wall-time budget; wallBudgetExceeded says it stopped early.',
  inputSchema: {
    ms: z.number().positive().optional(), frames: z.number().int().positive().optional(),
    until: z.string().optional(), maxMs: z.number().positive().optional(), pollMs: z.number().positive().optional(),
    inputs: z.array(z.object({ key: z.string(), atMs: z.number().min(0), holdMs: z.number().positive().optional() })).optional(),
    report: exprs.optional(),
  },
}, async (options) => json(await game.step(options)));

server.registerTool('gamecheck_state', {
  description: 'Reads game state cheaply: your named expressions, or, if the page offers window.__gamecheck.state(), its curated digest. Numbers are rounded and the result is capped (default 2000 bytes) with a dropped count. Prefer this to a screenshot.',
  inputSchema: { exprs: exprs.optional(), maxBytes: z.number().int().positive().optional(), digits: z.number().int().min(0).max(6).optional() },
  annotations: { readOnlyHint: true },
}, async (options) => json(await game.state(options)));

server.registerTool('gamecheck_watch', {
  description: 'Plays on for ms of game time and returns a summary per expression instead of raw samples: start, end, min, max, mean, slope per second, when the min and max happened, and for non-numbers the values seen and a capped timeline of changes. Use it to see how something moved over a stretch without spending tokens on every frame.',
  inputSchema: { exprs, ms: z.number().positive(), hz: z.number().min(1).max(60).optional() },
}, async (options) => json(await game.watch(options)));

server.registerTool('gamecheck_screenshot', {
  description: 'A PNG of the page as it stands now. Costs far more than gamecheck_state; use it for how something looks. Software rendering is the reference for pixels.',
  inputSchema: { maxWidth: z.number().int().min(200).max(1920).optional() },
  annotations: { readOnlyHint: true },
}, async ({ maxWidth }) => {
  const shot = await game.screenshot(maxWidth);
  return { content: [{ type: 'image' as const, data: shot.png.toString('base64'), mimeType: 'image/png' }, { type: 'text' as const, text: `${shot.width}x${shot.height}` }] };
});

server.registerTool('gamecheck_close', {
  description: 'Closes the game, releases the lock, and lets other headless runs go. Always call it when done.',
  inputSchema: {},
}, async () => json(await game.close()));

const shutdown = (): void => { void game.close().finally(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// A client that goes away closes our stdin: close the browser and free the lock then, not 10 idle minutes later.
process.stdin.once('end', shutdown);

await server.connect(new StdioServerTransport());
