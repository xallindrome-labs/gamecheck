import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openGame, playScenario, type Scenario } from '../src/index.js';
import { GAME } from './fixtures.js';

async function play(scenario: Omit<Scenario, 'html' | 'engine'>) {
  const session = await openGame({ html: GAME, engine: 'raf', stepped: true });
  try {
    return await playScenario(session, { ...scenario, html: GAME, engine: 'raf' });
  } finally {
    await session.close();
  }
}

test('measure: how long until a condition, in game time', async () => {
  const record = await play({
    id: 'm',
    steps: [{ do: 'measure', until: 'window.state.flag', as: 'm', pollMs: 100 }],
    expect: [{ at: 'm', path: 'ms', min: 4900, max: 5200, why: 'the five-second timer' }],
  });
  assert.equal(record.ok, true, JSON.stringify(record.observations));
});

test('measure: a cap and a stall are reported, not hung on', async () => {
  const capped = await play({
    id: 'c',
    steps: [{ do: 'measure', until: 'false', as: 'm', capMs: 1000, pollMs: 100 }],
    expect: [{ at: 'm', path: 'capped', equals: true, why: 'gave up at the cap' }],
  });
  assert.equal(capped.ok, true, JSON.stringify(capped.observations));
  const stalled = await play({
    id: 's',
    steps: [{ do: 'measure', until: 'false', as: 'm', capMs: 20_000, pollMs: 100, progress: '1', stallMs: 500 }],
    expect: [
      { at: 'm', path: 'stalled', equals: true, why: 'progress stopped changing' },
      { at: 'm', path: 'ms', max: 800, why: 'noticed soon after' },
    ],
  });
  assert.equal(stalled.ok, true, JSON.stringify(stalled.observations));
});

test('soak: an invariant that breaks is reported at the game time it broke', async () => {
  const record = await play({
    id: 'k',
    steps: [{ do: 'soak', ms: 5000, invariant: 'window.state.x < 100', as: 'k' }],
    expect: [
      { at: 'k', path: 'ok', equals: false, why: 'x passed 100' },
      { at: 'k', path: 'violatedAtMs', min: 900, max: 1200, why: 'about one second in' },
    ],
  });
  assert.equal(record.ok, true, JSON.stringify(record.observations));
});

test('soak: seeded random inputs replay exactly', async () => {
  const run = () => play({
    id: 'r',
    steps: [
      { do: 'soak', ms: 6000, invariant: 'true', as: 'k', inputs: { keys: ['ArrowRight', 'ArrowLeft', 'x'], seed: 7, everyMs: 300, holdMs: 100 } },
      { do: 'snapshot', as: 'end', expr: '({ x: Math.round(window.state.x * 10) / 10 })' },
    ],
    expect: [{ at: 'k', path: 'ok', equals: true, why: 'invariant held' }],
  });
  const a = await run();
  const b = await run();
  assert.equal(a.ok, true);
  assert.deepEqual(a.recorded, b.recorded);
});
