import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { openGame, type Session } from '../src/index.js';

const require = createRequire(import.meta.url);

async function openPhaser(render: boolean): Promise<Session> {
  const phaser = require.resolve('phaser/dist/phaser.min.js');
  return openGame({
    html: '<div id="game"></div>', engine: 'phaser', gameRef: 'window.__GAME__', stepped: true, render,
    beforeStart: async (page) => {
      await page.addScriptTag({ path: phaser });
      await page.evaluate(() => {
        const w = window as unknown as { Phaser: any; __GAME__: unknown; __x: number; __frames: number; __draws: number };
        w.__x = 0;
        w.__frames = 0;
        w.__draws = 0;
        w.__GAME__ = new w.Phaser.Game({
          type: w.Phaser.CANVAS, width: 320, height: 200, parent: 'game', audio: { noAudio: true },
          scene: {
            update: (_time: number, delta: number) => { w.__x += (100 * delta) / 1000; w.__frames += 1; },
            create(this: { sys: { events: { on(event: string, fn: () => void): void } } }) { this.sys.events.on('render', () => { w.__draws += 1; }); },
          },
        });
      });
      await page.waitForFunction(() => (window as unknown as { __GAME__: { isRunning: boolean } }).__GAME__.isRunning);
    },
  });
}

async function play(render: boolean): Promise<{ x: number; frames: number; draws: number; wall: number }> {
  const session = await openPhaser(render);
  try {
    const before = await session.evaluate<{ frames: number; draws: number }>('({ frames: window.__frames, draws: window.__draws })');
    const started = Date.now();
    await session.advance(20_000);
    const wall = Date.now() - started;
    const after = await session.evaluate<{ x: number; frames: number; draws: number }>('({ x: window.__x, frames: window.__frames, draws: window.__draws })');
    return { x: after.x, frames: after.frames - before.frames, draws: after.draws - before.draws, wall };
  } finally {
    await session.close();
  }
}

test('phaser engine: render false steps the same game logic without drawing', async () => {
  const drawn = await play(true);
  const headless = await play(false);
  assert.ok(Math.abs(drawn.x - headless.x) < 2, `x ${drawn.x} drawn, ${headless.x} headless`);
  assert.equal(drawn.frames, headless.frames);
  assert.ok(drawn.draws > 0, 'the rendered run drew');
  assert.equal(headless.draws, 0);
  console.log(`      20 game seconds: drawn ${drawn.wall} ms, headless ${headless.wall} ms`);
});
