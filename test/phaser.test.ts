import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { openGame, type OpenOptions, type Session } from '../src/index.js';

const require = createRequire(import.meta.url);

async function openPhaser(render: boolean, extra: Partial<OpenOptions> = {}): Promise<Session> {
  const phaser = require.resolve('phaser/dist/phaser.min.js');
  return openGame({
    html: '<div id="game"></div>', engine: 'phaser', gameRef: 'window.__GAME__', stepped: true, render, ...extra,
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

test('phaser: drawEvery draws one frame in N, updates every frame, and always draws the last frame of an advance', async () => {
  const session = await openPhaser(true, { drawEvery: 4 });
  try {
    const before = await session.evaluate<{ frames: number; draws: number }>('({ frames: window.__frames, draws: window.__draws })');
    await session.advance(1000);
    const a = await session.evaluate<{ frames: number; draws: number }>('({ frames: window.__frames, draws: window.__draws })');
    assert.equal(a.frames - before.frames, 60, 'every frame updated');
    const drawn = a.draws - before.draws;
    assert.ok(drawn >= 14 && drawn <= 17, `drew ${drawn} of 60`);
    await session.advance(50);
    const b = await session.evaluate<{ frames: number; draws: number }>('({ frames: window.__frames, draws: window.__draws })');
    assert.equal(b.frames - a.frames, 3);
    assert.ok(b.draws - a.draws >= 1, 'the last frame of a short advance is drawn, so what is read afterwards is current');
  } finally {
    await session.close();
  }
});

test('phaser: drawEvery gives the same change in game state as drawing every frame', async () => {
  const run = async (extra: Partial<OpenOptions>): Promise<number> => {
    const session = await openPhaser(true, extra);
    try {
      const before = await session.evaluate<number>('window.__x');
      await session.advance(5000);
      return Math.round(((await session.evaluate<number>('window.__x')) - before) * 1e6) / 1e6;
    } finally {
      await session.close();
    }
  };
  assert.equal(await run({ drawEvery: 5 }), await run({}));
});

test('phaser: stepping without drawing repeats exactly, measured from the moment the clock took over', async () => {
  // A Phaser game runs by itself, in real time, until the clock starts, so the value at open differs by a frame or so from
  // run to run. What gamecheck controls is everything after: the change over an advance must be identical.
  const changes: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const session = await openPhaser(false);
    try {
      const before = await session.evaluate<number>('window.__x');
      await session.advance(7000);
      changes.push(Math.round(((await session.evaluate<number>('window.__x')) - before) * 1e6) / 1e6);
    } finally {
      await session.close();
    }
  }
  assert.equal(new Set(changes).size, 1, `four runs changed x by ${changes.join(', ')}`);
  assert.ok(Math.abs((changes[0] ?? 0) - 700) < 2, `700 px expected, got ${changes[0]}`);
});
