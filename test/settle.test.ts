import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openGame } from '../src/index.js';
import { serve } from './fixtures.js';

const LOADER = `<script>
window.loaded = false;
window.tick = 0;
fetch('/slow').then((r) => r.text()).then(() => { window.loaded = true; });
(function frame() { window.tick += 1; requestAnimationFrame(frame); })();
</script>`;

test('settle: opening waits for a slow load, in game time, before handing the page over', async () => {
  const site = await serve({ '/index.html': LOADER }, { '/slow': 400 });
  const session = await openGame({ url: `${site.url}/index.html`, engine: 'raf', stepped: true });
  try {
    assert.equal(await session.evaluate<boolean>('window.loaded'), true);
    assert.deepEqual(await session.settle(), { advancedMs: 0, abandoned: false });
  } finally {
    await session.close();
    await site.close();
  }
});

test('settle: with settle off the load is still pending, and settle() then waits for it', async () => {
  const site = await serve({ '/index.html': LOADER }, { '/slow': 400 });
  const session = await openGame({ url: `${site.url}/index.html`, engine: 'raf', stepped: true, settle: false });
  try {
    assert.equal(await session.evaluate<boolean>('window.loaded'), false);
    const result = await session.settle();
    assert.equal(result.abandoned, false);
    assert.ok(result.advancedMs > 0);
    assert.equal(await session.evaluate<boolean>('window.loaded'), true);
  } finally {
    await session.close();
    await site.close();
  }
});

test('settle: work that never finishes is abandoned, and says so', async () => {
  const site = await serve({ '/index.html': LOADER }, { '/slow': 60_000 });
  const session = await openGame({ url: `${site.url}/index.html`, engine: 'raf', stepped: true, settle: false });
  try {
    const result = await session.settle({ timeoutMs: 500 });
    assert.equal(result.abandoned, true);
  } finally {
    await session.close();
    await site.close();
  }
});

test('settle: a page with nothing pending costs no game time', async () => {
  const session = await openGame({ html: '<script>window.tick = 0; (function f() { window.tick += 1; requestAnimationFrame(f); })();</script>', engine: 'raf', stepped: true });
  try {
    assert.deepEqual(await session.settle(), { advancedMs: 0, abandoned: false });
  } finally {
    await session.close();
  }
});

const ANIMATED = `<style>
@keyframes slide { from { transform: translateX(0); } to { transform: translateX(100px); } }
#box { width: 10px; height: 10px; background: red; animation: slide 1s linear forwards; }
</style><div id="box"></div><script>(function f() { requestAnimationFrame(f); })();</script>`;

test('animations: a CSS animation follows game time, not the wall clock', async () => {
  const session = await openGame({ html: ANIMATED, engine: 'raf', stepped: true });
  try {
    const time = (): Promise<number> => session.evaluate<number>('Number(document.getAnimations()[0].currentTime)');
    await session.advance(100);
    const first = await time();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await time(), first, 'it stood still while the wall clock ran');
    await session.advance(400);
    const second = await time();
    assert.ok(Math.abs(second - first - 400) < 20, `moved ${second - first} ms for 400 ms of game time`);
  } finally {
    await session.close();
  }
});
