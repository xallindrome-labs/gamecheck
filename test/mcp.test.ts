import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ProgressSnapshot, Scenario } from '../src/index.js';
import { GAME } from './fixtures.js';

const MCP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.js');

const SCENARIO: Scenario = {
  id: 'mcp.walk', proves: 'the walker walks', html: GAME,
  steps: [{ do: 'advance', ms: 3000 }, { do: 'snapshot', as: 'end', expr: 'Math.round(state.x)' }],
  expect: [{ at: 'end', min: 290, max: 310, why: 'three seconds at 100 px/s' }],
};

async function connect(cwd: string): Promise<Client> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.GAMECHECK_PROGRESS;
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], cwd, env, stderr: 'ignore' }));
  return client;
}

/** The server may still be exiting, and Windows will not delete a folder a process has as its working folder: retry, and never fail a test over cleanup. */
const cleanup = (dir: string): void => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* left in the temp folder */ } };

const text = (result: unknown): string => ((result as { content: { type: string; text: string }[] }).content.find((c) => c.type === 'text')?.text) ?? '';

test('mcp: every tool offers the lean options, and the panel file is on by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-mcp-'));
  const client = await connect(dir);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['gamecheck_run', 'gamecheck_compare', 'gamecheck_open']) {
      const props = Object.keys((tools.find((t) => t.name === name)?.inputSchema as { properties: object }).properties);
      for (const option of ['lean', 'render', 'drawEvery', 'priority', 'memoryMb', 'viewport']) assert.ok(props.includes(option), `${name} offers ${option}`);
    }

    const result = await client.callTool({ name: 'gamecheck_run', arguments: { scenario: SCENARIO, lean: true } });
    assert.match(text(result), /^ok mcp\.walk/);

    const progress = JSON.parse(readFileSync(join(dir, '.gamecheck', 'progress.json'), 'utf8')) as ProgressSnapshot;
    assert.equal(progress.state, 'done');
    assert.equal(progress.passed, 1);
    assert.match(progress.label, /lean/);
  } finally {
    await client.close();
    cleanup(dir);
  }
});

test('mcp: an interactive session shows in the panel file while it is open, and finishes when closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-mcp-'));
  const client = await connect(dir);
  const file = join(dir, '.gamecheck', 'progress.json');
  const read = (): ProgressSnapshot => JSON.parse(readFileSync(file, 'utf8')) as ProgressSnapshot;
  try {
    await client.callTool({ name: 'gamecheck_open', arguments: { html: GAME, engine: 'raf', lean: true } });
    assert.equal(read().state, 'running');
    assert.match(read().label, /interactive/);

    await client.callTool({ name: 'gamecheck_step', arguments: { ms: 2000 } });
    // The file is rewritten at most every 250 ms, with a trailing write for the latest state: give it a moment.
    for (let waited = 0; waited < 3000 && !/step 2000 ms/.test(read().current?.step ?? ''); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match(read().current?.step ?? '', /step 2000 ms/);

    await client.callTool({ name: 'gamecheck_close', arguments: {} });
    assert.equal(read().state, 'done');
  } finally {
    await client.close();
    cleanup(dir);
  }
});

test('mcp: GAMECHECK_PROGRESS=off turns the panel file off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-mcp-'));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], cwd: dir, env: { ...(process.env as Record<string, string>), GAMECHECK_PROGRESS: 'off' }, stderr: 'ignore' }));
  try {
    const result = await client.callTool({ name: 'gamecheck_run', arguments: { scenario: SCENARIO } });
    assert.match(text(result), /^ok /);
    assert.throws(() => readFileSync(join(dir, '.gamecheck', 'progress.json')), /ENOENT/);
  } finally {
    await client.close();
    cleanup(dir);
  }
});
