import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { test } from 'node:test';
import { createSteppedClock, launchTuning, lowerPriority, LEAN_ARGS, openGame, runScenario, type Scenario } from '../src/index.js';
import { GAME } from './fixtures.js';

// ---- no browser ----

test('launchTuning: plain by default, lean on request, and each part overridable', () => {
  const plain = launchTuning({});
  assert.deepEqual(plain, { args: [], viewport: { width: 1280, height: 720 }, priority: 'normal' });

  const lean = launchTuning({ lean: true });
  assert.deepEqual(lean.args, LEAN_ARGS);
  assert.deepEqual(lean.viewport, { width: 640, height: 360 });
  assert.equal(lean.priority, 'low');

  const mixed = launchTuning({ lean: true, viewport: { width: 800, height: 450 }, priority: 'normal', memoryMb: 512 });
  assert.deepEqual(mixed.viewport, { width: 800, height: 450 });
  assert.equal(mixed.priority, 'normal');
  assert.ok(!mixed.args.some((arg) => arg.startsWith('--js-flags')), 'the memory ceiling is a watchdog, not a V8 flag: a heap limit makes a runaway page thrash instead of crash');
});

test('launchTuning: the lean flags leave rendering and timers alone', () => {
  for (const arg of LEAN_ARGS) assert.doesNotMatch(arg, /gpu|angle|swiftshader|raster|renderer-backgrounding|autoplay|timer/i, arg);
  assert.throws(() => launchTuning({ memoryMb: 8 }), /at least 256/);
});

test('lowerPriority: changes this process and restores it, and normal changes nothing', () => {
  const before = os.getPriority(0);
  lowerPriority('normal')();
  assert.equal(os.getPriority(0), before);
  const restore = lowerPriority('low');
  assert.ok(os.getPriority(0) > before || before >= os.constants.priority.PRIORITY_BELOW_NORMAL, 'low is a larger niceness on Unix, a lower class on Windows');
  restore();
  assert.equal(os.getPriority(0), before);
});

test('drawEvery is checked up front', () => {
  for (const bad of [0, -1, 1.5]) {
    assert.throws(() => createSteppedClock({} as never, { engine: 'phaser', gameRef: 'window.g', drawEvery: bad }), /drawEvery/);
  }
});

// ---- browser ----

/** Priority class of every headless Chrome process (Windows). Only the headless shell: the PC's own Chrome is not ours to judge. */
function chromePriorities(): string[] {
  const script = "Get-Process -Name chrome-headless-shell -ErrorAction SilentlyContinue | ForEach-Object { $_.PriorityClass.ToString() }";
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return out.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

test('lean: opens a 640x360 canvas, and a plain open keeps 1280x720', async () => {
  const lean = await openGame({ html: GAME, engine: 'raf', stepped: true, lean: true });
  try {
    assert.deepEqual(await lean.evaluate('[innerWidth, innerHeight]'), [640, 360]);
  } finally {
    await lean.close();
  }
  const plain = await openGame({ html: GAME, engine: 'raf', stepped: true });
  try {
    assert.deepEqual(await plain.evaluate('[innerWidth, innerHeight]'), [1280, 720]);
  } finally {
    await plain.close();
  }
});

test('lean: a lean run gives the same answer as a plain one', async () => {
  const scenario: Scenario = {
    id: 'lean.same', html: GAME, steps: [{ do: 'advance', ms: 10_000 }, { do: 'snapshot', as: 'end', expr: '({ beats: state.beats, flag: state.flag, x: Math.round(state.x) })' }],
    expect: [{ at: 'end', path: 'beats', equals: 10, why: 'ten beats' }, { at: 'end', path: 'flag', equals: true, why: 'the flag came up' }],
  };
  const plain = await runScenario(scenario, { stepped: true });
  const lean = await runScenario(scenario, { stepped: true, lean: true });
  assert.equal(plain.ok, true);
  assert.equal(lean.ok, true);
  assert.deepEqual(lean.recorded, plain.recorded);
});

test('priority: every headless Chrome process is held below normal when asked, and none is lowered otherwise', { skip: process.platform !== 'win32' }, async () => {
  const low = await openGame({ html: GAME, engine: 'raf', stepped: true, priority: 'low' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const classes = chromePriorities();
    assert.ok(classes.length > 0, 'found Chrome processes');
    assert.ok(classes.every((c) => c === 'BelowNormal'), `Chrome processes: ${classes.join(', ')}`);
  } finally {
    await low.close();
  }
  const normal = await openGame({ html: GAME, engine: 'raf', stepped: true });
  try {
    const classes = chromePriorities();
    assert.ok(classes.length > 0);
    assert.ok(classes.every((c) => c !== 'BelowNormal' && c !== 'Idle'), `a plain run lowers nothing: ${classes.join(', ')}`);
  } finally {
    await normal.close();
  }
});

test('memoryMb: a page that grows without end is killed at the ceiling, and the run says why', async () => {
  const session = await openGame({ html: '<body></body>', engine: 'raf', stepped: false, memoryMb: 900 });
  const started = Date.now();
  try {
    // 50 MB more every 100 ms, written to so the memory is really used, for at most 30 chunks (1.5 GB) if the watchdog failed.
    await assert.rejects(session.evaluate('(async () => { const held = []; for (let i = 0; i < 30; i += 1) { const chunk = new Uint8Array(50e6); chunk.fill(1); held.push(chunk); await new Promise((r) => setTimeout(r, 100)); } return held.length; })()'));
    const over = session.memoryExceeded;
    assert.ok(over, 'the session says the ceiling killed the browser');
    assert.equal(over.limitMb, 900);
    assert.ok(over.usedMb > 900, `used ${over.usedMb} MB`);
    assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
  } finally {
    await session.close();
  }
});

test('memoryMb: a scenario that is killed fails with the reason, not just a closed browser', async () => {
  const scenario: Scenario = {
    id: 'lean.memory', html: '<body></body>',
    steps: [{ do: 'eval', expr: '(async () => { const held = []; for (let i = 0; i < 30; i += 1) { const chunk = new Uint8Array(50e6); chunk.fill(1); held.push(chunk); await new Promise((r) => setTimeout(r, 100)); } return held.length; })()' }],
    expect: [],
  };
  const record = await runScenario(scenario, { stepped: false, memoryMb: 900 });
  assert.equal(record.ok, false);
  assert.match(record.error ?? '', /memory ceiling exceeded: Chrome used \d+ MB against a limit of 900 MB/);
});
