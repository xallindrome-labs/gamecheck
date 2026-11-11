import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interactive } from '../src/index.js';
import { GAME } from './fixtures.js';

const open = async (idleMs?: number): Promise<Interactive> => {
  const game = new Interactive(idleMs);
  await game.open({ html: GAME, engine: 'raf' });
  return game;
};

test('interactive: step, state and until work on a stopped clock', async () => {
  const game = await open();
  try {
    const first = await game.step({ ms: 2000 });
    assert.equal(first.advancedMs, 2000);
    const read = await game.state({ exprs: { x: 'window.state.x', flag: 'window.state.flag' } });
    const state = read.state as { x: number; flag: boolean };
    assert.ok(Math.abs(state.x - 200) < 3, `x ${state.x}`);
    assert.equal(state.flag, false);
    const waited = await game.step({ until: 'window.state.flag', maxMs: 10_000 });
    assert.equal(waited.predicateMet, true);
    assert.ok(waited.advancedMs >= 2900 && waited.advancedMs <= 3200, `waited ${waited.advancedMs}`);
    const missed = await game.step({ until: 'false', maxMs: 500 });
    assert.equal(missed.predicateMet, false);
  } finally {
    await game.close();
  }
});

test('interactive: inputs fire on the game clock, and report says what changed', async () => {
  const game = await open();
  try {
    await game.step({ ms: 1000 });
    const moved = await game.step({
      ms: 1000, inputs: [{ key: 'ArrowRight', atMs: 0, holdMs: 1000 }],
      report: { x: 'Math.round(window.state.x)', flag: 'window.state.flag' },
    });
    assert.deepEqual(moved.report?.changed, ['x']);
    assert.ok(Math.abs((moved.report?.after.x as number) - 300) < 6, JSON.stringify(moved.report));
    const cut = await game.step({ ms: 500, inputs: [{ key: 'ArrowRight', atMs: 100, holdMs: 5000 }] });
    assert.deepEqual(cut.forcedReleases, ['ArrowRight']);
  } finally {
    await game.close();
  }
});

test('interactive: watch summarises a stretch of play without raw samples', async () => {
  const game = await open();
  try {
    const watched = await game.watch({ exprs: { x: 'window.state.x', beats: 'window.state.beats' }, ms: 3000, hz: 10 });
    const x = watched.fields.x;
    assert.ok(x && x.slope !== undefined && Math.abs(x.slope - 100) < 3, JSON.stringify(x));
    assert.equal(watched.fields.beats?.end, 3);
    assert.ok(watched.samples >= 30);
  } finally {
    await game.close();
  }
});

test('interactive: state uses the page contract when it has one, and caps it', async () => {
  const game = new Interactive();
  await game.open({ html: `${GAME}<script>window.__gamecheck = { state: () => ({ x: window.state.x, long: 'y'.repeat(5000), z: 1.23456 }) };</script>`, engine: 'raf' });
  try {
    await game.step({ ms: 1000 });
    const read = await game.state({ maxBytes: 100 });
    assert.equal(read.truncated, true);
    assert.ok(JSON.stringify(read.state).length <= 100);
  } finally {
    await game.close();
  }
});

test('interactive: a screenshot is a PNG, and a closed game says so', async () => {
  const game = await open();
  try {
    const shot = await game.screenshot(400);
    assert.equal(shot.png.subarray(0, 4).toString('hex'), '89504e47');
    assert.equal(shot.width, 400);
  } finally {
    await game.close();
  }
  await assert.rejects(() => game.step({ ms: 100 }), /no game is open/);
});

test('interactive: an idle game closes itself and lets the lock go', async () => {
  const game = await open(400);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(game.isOpen, false);
});
