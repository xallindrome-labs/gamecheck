#!/usr/bin/env node
import { Progress, progressFile } from './progress.js';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Interactive } from './interactive.js';
import { compareClocks, runScenario, type Scenario, type ScenarioRecord } from './scenario.js';

const scenarioInput = z.union([z.string(), z.record(z.string(), z.unknown())]).describe('A scenario object, or the path of a scenario JSON file');
const shared = {
  scenario: scenarioInput,
  url: z.string().optional().describe("The page to test; overrides the scenario's own"),
  gpu: z.boolean().optional().describe('Draw on the real GPU: faster for logic checks, not for pixels'),
};

function load(input: string | Record<string, unknown>, url?: string): Scenario {
  const scenario = (typeof input === 'string' ? JSON.parse(readFileSync(input, 'utf8')) : input) as Scenario;
  return url ? { ...scenario, url } : scenario;
}

/** One line per result, so an agent spends few tokens; the full record only for what failed. */
function summary(record: ScenarioRecord): string {
  const failed = record.observations.filter((one) => !one.ok).map((one) => `${one.why}: got ${JSON.stringify(one.actual)}`);
  return `${record.ok ? 'ok' : 'FAIL'} ${record.id} (${record.clock}, ${(record.ms / 1000).toFixed(1)} s)${record.error ? `: ${record.error}` : ''}${failed.length ? `\n  ${failed.join('\n  ')}` : ''}`;
}

const server = new McpServer({ name: 'gamecheck', version: '0.1.0' });

server.registerTool('gamecheck_run', {
  description: 'Plays a game-check scenario in a headless browser, stepping the game by hand (fast and deterministic) unless real is set. Returns a short verdict and what failed.',
  inputSchema: { ...shared, real: z.boolean().optional().describe('Use the real clock instead of stepping the game') },
}, async ({ scenario, url, gpu, real }) => {
  const loaded = load(scenario, url);
  const target = progressFile();
  const progress = target ? new Progress({ file: target, total: 1, label: 'gamecheck_run' }) : undefined;
  progress?.begin(loaded);
  try {
    const record = await runScenario(loaded, { gpu, stepped: !real }, progress);
    progress?.end({ id: record.id, ok: record.ok, ms: record.ms, why: record.error ?? record.observations.find((one) => !one.ok)?.why });
    return { content: [{ type: 'text' as const, text: summary(record) }], isError: !record.ok };
  } finally {
    progress?.finish();
  }
});

server.registerTool('gamecheck_compare', {
  description: 'Plays a scenario on the real clock and on the stepped one and lists every verdict or observed value that differs. Run it before trusting stepped results for a scenario.',
  inputSchema: shared,
}, async ({ scenario, url, gpu }) => {
  const result = await compareClocks(load(scenario, url), { gpu });
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
    render: z.boolean().optional().describe('Phaser only: false skips drawing for the fastest steps; camera-view values and screenshots go stale'),
  },
}, async ({ url, html, engine, gameRef, gpu, real, render }) => json(await game.open({ url, html, engine, gameRef, gpu, render, stepped: !real })));

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

process.on('SIGINT', () => { void game.close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void game.close().finally(() => process.exit(0)); });

await server.connect(new StdioServerTransport());
