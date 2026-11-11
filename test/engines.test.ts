import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openGame } from '../src/index.js';
import { serve } from './fixtures.js';

const PIXI_PAGE = `<body></body><script src="/node_modules/pixi.js/dist/pixi.min.js"></script><script>
(async () => {
  const app = new PIXI.Application();
  await app.init({ width: 320, height: 200 });
  document.body.appendChild(app.canvas);
  const box = new PIXI.Graphics().rect(0, 0, 10, 10).fill(0xff0000);
  app.stage.addChild(box);
  window.box = box;
  app.ticker.add((ticker) => { box.x += 60 * ticker.deltaMS / 1000; });
  window.ready = true;
})();
</script>`;

const THREE_PAGE = `<script type="importmap">{ "imports": { "three": "/node_modules/three/build/three.module.js" } }</script>
<script type="module">
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 200);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 100);
camera.position.z = 5;
const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
scene.add(mesh);
const clock = new THREE.Clock();
window.mesh = mesh;
function tick() { mesh.position.x += 2 * clock.getDelta(); renderer.render(scene, camera); requestAnimationFrame(tick); }
requestAnimationFrame(tick);
window.ready = true;
</script>`;

test('raf engine drives PixiJS: its ticker moves a sprite by game time', async () => {
  const site = await serve({ '/index.html': PIXI_PAGE });
  const session = await openGame({ url: `${site.url}/index.html`, engine: 'raf', stepped: true });
  try {
    await session.until('window.ready', { timeoutMs: 30_000 });
    const start = await session.evaluate<number>('window.box.x');
    const started = Date.now();
    await session.advance(5000);
    const wall = Date.now() - started;
    const moved = (await session.evaluate<number>('window.box.x')) - start;
    assert.ok(Math.abs(moved - 300) < 12, `moved ${moved}`);
    assert.ok(wall < 4000, `took ${wall} ms`);
  } finally {
    await session.close();
    await site.close();
  }
});

test('raf engine drives three.js: THREE.Clock follows game time', async () => {
  const site = await serve({ '/index.html': THREE_PAGE });
  const session = await openGame({ url: `${site.url}/index.html`, engine: 'raf', stepped: true });
  try {
    await session.until('window.ready', { timeoutMs: 30_000 });
    const start = await session.evaluate<number>('window.mesh.position.x');
    await session.advance(5000);
    const moved = (await session.evaluate<number>('window.mesh.position.x')) - start;
    assert.ok(Math.abs(moved - 10) < 0.5, `moved ${moved}`);
  } finally {
    await session.close();
    await site.close();
  }
});
