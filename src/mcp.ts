#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
  const record = await runScenario(load(scenario, url), { gpu, stepped: !real });
  return { content: [{ type: 'text' as const, text: summary(record) }], isError: !record.ok };
});

server.registerTool('gamecheck_compare', {
  description: 'Plays a scenario on the real clock and on the stepped one and lists every verdict or observed value that differs. Run it before trusting stepped results for a scenario.',
  inputSchema: shared,
}, async ({ scenario, url, gpu }) => {
  const result = await compareClocks(load(scenario, url), { gpu });
  const text = `${result.equivalent ? 'EQUIVALENT' : 'DIFFERENT'} ${result.id}: real ${result.real.ok ? 'pass' : 'fail'} ${(result.real.ms / 1000).toFixed(1)} s, stepped ${result.stepped.ok ? 'pass' : 'fail'} ${(result.stepped.ms / 1000).toFixed(1)} s${result.differences.length ? `\n  ${result.differences.join('\n  ')}` : ''}`;
  return { content: [{ type: 'text' as const, text }], isError: !result.equivalent };
});

await server.connect(new StdioServerTransport());
