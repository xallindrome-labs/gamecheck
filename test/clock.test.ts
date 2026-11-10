import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { compareClocks, openGame, type Scenario } from '../src/index.js';
import { GAME } from './fixtures.js';

test('raf engine: ten game seconds pass in well under ten real seconds, and every clock agrees', async () => {
  const session = await openGame({ html: GAME, engine: 'raf', stepped: true });
  try {
    const started = Date.now();
    await session.advance(10_000);
    const wall = Date.now() - started;
    const state = await session.evaluate<{ x: number; flag: boolean; beats: number; dateMs: number }>('window.state');
    assert.ok(Math.abs(state.x - 1000) < 5, `x ${state.x}`);
    assert.equal(state.flag, true);
    assert.equal(state.beats, 10);
    assert.ok(Math.abs(state.dateMs - 10_000) < 50, `Date.now moved ${state.dateMs}`);
    assert.ok(wall < 3000, `took ${wall} ms of wall time`);
  } finally {
    await session.close();
  }
});

test('raf engine: a held key moves the game for exactly the game time it is held', async () => {
  const session = await openGame({ html: GAME, engine: 'raf', stepped: true });
  try {
    await session.advance(1000);
    await session.press('ArrowRight', 1000);
    await session.advance(1000);
    const x = await session.evaluate<number>('window.state.x');
    assert.ok(Math.abs(x - 400) < 8, `x ${x}`);
  } finally {
    await session.close();
  }
});

test('raf engine: until counts game time, not wall time', async () => {
  const session = await openGame({ html: GAME, engine: 'raf', stepped: true });
  try {
    const waited = await session.until('window.state.flag', { timeoutMs: 20_000, pollMs: 100 });
    assert.ok(waited >= 4900 && waited <= 5200, `waited ${waited}`);
  } finally {
    await session.close();
  }
});

test('phaser engine: the game is stepped by hand, with its own delta', async () => {
  const require = createRequire(import.meta.url);
  const phaser = require.resolve('phaser/dist/phaser.min.js');
  const session = await openGame({
    html: '<div id="game"></div>', engine: 'phaser', gameRef: 'window.__GAME__', stepped: true,
    beforeStart: async (page) => {
      await page.addScriptTag({ path: phaser });
      await page.evaluate(() => {
        const w = window as unknown as { Phaser: any; __GAME__: unknown; __x: number };
        w.__x = 0;
        w.__GAME__ = new w.Phaser.Game({
          type: w.Phaser.CANVAS, width: 320, height: 200, parent: 'game', audio: { noAudio: true },
          scene: { update: (_time: number, delta: number) => { w.__x += (100 * delta) / 1000; } },
        });
      });
      await page.waitForFunction(() => (window as unknown as { __GAME__: { isRunning: boolean } }).__GAME__.isRunning);
    },
  });
  try {
    const before = await session.evaluate<number>('window.__x');
    const started = Date.now();
    await session.advance(30_000);
    const wall = Date.now() - started;
    const after = await session.evaluate<number>('window.__x');
    assert.ok(Math.abs(after - before - 3000) < 10, `moved ${after - before}`);
    assert.ok(wall < 5000, `took ${wall} ms of wall time`);
  } finally {
    await session.close();
  }
});

test('compare: the stepped clock gives the same answers as the real one on a short scenario', async () => {
  const scenario: Scenario = {
    id: 'raf.short', html: GAME, engine: 'raf',
    steps: [{ do: 'advance', ms: 2000 }, { do: 'snapshot', as: 's', expr: '({ x: Math.round(window.state.x / 50) * 50, flag: window.state.flag, beats: window.state.beats })' }],
    expect: [
      { at: 's', path: 'x', equals: 200, why: 'moved 200 px in two seconds' },
      { at: 's', path: 'flag', equals: false, why: 'the five-second timer has not fired' },
      { at: 's', path: 'beats', equals: 2, why: 'two beats' },
    ],
  };
  const result = await compareClocks(scenario);
  assert.deepEqual(result.differences, []);
  assert.equal(result.equivalent, true);
});
