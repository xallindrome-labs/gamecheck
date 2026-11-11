// What does a stepped run cost the machine, and what does each lean option save?
//
//   node bench/cost.mjs [--seconds 30] [--repeats 2] [--out bench/cost.json]
//
// Plays the same graphics-heavy Phaser (WebGL, software-rendered) page under each configuration and records wall time,
// the CPU seconds Chrome used in total (all its processes, from the DevTools SystemInfo domain) and its peak memory
// (the Windows task list, polled; skipped elsewhere). Run it under the shared headless lock if you have one:
// GAMECHECK_LOCK=<path> node bench/cost.mjs
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { openGame } from '../dist/src/index.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const SECONDS = Number(arg('seconds', 30));
const REPEATS = Number(arg('repeats', 2));
const OUT = arg('out', 'bench/cost.json');

const CONFIGS = [
  ['baseline: 1280x720, draw every frame', {}],
  ['lean: 640x360, lighter Chrome, low priority', { lean: true }],
  ['lean + draw 1 frame in 4', { lean: true, drawEvery: 4 }],
  ['lean + no drawing', { lean: true, render: false }],
  ['1280x720 + no drawing', { render: false }],
];

async function chromeMemoryMb() {
  if (process.platform !== 'win32') return undefined;
  try {
    const { stdout } = await exec('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq chrome-headless-shell.exe']);
    let kb = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const cells = line.match(/"([^"]*)"/g);
      if (cells && cells.length >= 5) kb += Number(cells[4].replace(/[^0-9]/g, '')) || 0;
    }
    return kb / 1024;
  } catch { return undefined; }
}

async function once(options) {
  const phaser = require.resolve('phaser/dist/phaser.min.js');
  const session = await openGame({
    html: '<div id="game"></div>', engine: 'phaser', gameRef: 'window.__GAME__', stepped: true, ...options,
    beforeStart: async (page) => {
      await page.addScriptTag({ path: phaser });
      await page.evaluate(() => {
        const w = window;
        w.__GAME__ = new w.Phaser.Game({
          type: w.Phaser.WEBGL, width: 960, height: 540, parent: 'game', audio: { noAudio: true }, backgroundColor: '#102030',
          scene: {
            create() {
              const g = this.make.graphics({ x: 0, y: 0, add: false });
              g.fillStyle(0xffcc00, 1).fillCircle(8, 8, 8).generateTexture('dot', 16, 16);
              w.__dots = Array.from({ length: 2500 }, (_, i) => this.add.image((i * 37) % 960, (i * 53) % 540, 'dot').setTint(0x404040 + i * 977).setScale(1 + (i % 5) / 4));
              w.__ticks = 0;
            },
            update(_t, delta) { w.__ticks += 1; for (const d of w.__dots) { d.x = (d.x + delta * 0.05) % 960; d.rotation += 0.01; } },
          },
        });
      });
      await page.waitForFunction(() => window.__GAME__.isRunning && window.__ticks !== undefined);
    },
  });
  let peak = 0;
  let sampling = true;
  const sampler = (async () => { while (sampling) { peak = Math.max(peak, (await chromeMemoryMb()) ?? 0); await new Promise((r) => setTimeout(r, 400)); } })();
  try {
    const cdp = await session.browser.newBrowserCDPSession();
    const cpu = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.reduce((sum, p) => sum + p.cpuTime, 0);
    const cpu0 = await cpu();
    const t0 = Date.now();
    await session.advance(SECONDS * 1000);
    const wall = (Date.now() - t0) / 1000;
    const cpuSeconds = (await cpu()) - cpu0;
    const ticks = await session.evaluate('window.__ticks');
    return { wall, cpuSeconds, ticks };
  } finally {
    sampling = false;
    await sampler;
    peak = Math.max(peak, (await chromeMemoryMb()) ?? 0);
    await session.close();
    once.peak = peak;
  }
}

const rows = [];
for (const [label, options] of CONFIGS) {
  const runs = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const result = await once(options);
    runs.push({ ...result, peakMb: once.peak || undefined });
  }
  const mean = (key) => runs.reduce((s, r) => s + (r[key] ?? 0), 0) / runs.length;
  const row = { label, options, wall: mean('wall'), cpuSeconds: mean('cpuSeconds'), peakMb: runs.some((r) => r.peakMb) ? Math.max(...runs.map((r) => r.peakMb ?? 0)) : undefined, ticks: runs[0].ticks, runs };
  rows.push(row);
  console.log(`${label.padEnd(46)} wall ${row.wall.toFixed(1).padStart(5)} s   chrome cpu ${row.cpuSeconds.toFixed(1).padStart(5)} s   peak ${row.peakMb ? `${Math.round(row.peakMb)} MB` : 'n/a'}   updates ${row.ticks}`);
}
const base = rows[0];
console.log('\nagainst the baseline:');
for (const row of rows.slice(1)) console.log(`${row.label.padEnd(46)} wall ${(base.wall / row.wall).toFixed(1)}x faster   cpu ${(base.cpuSeconds / row.cpuSeconds).toFixed(1)}x less${base.peakMb && row.peakMb ? `   memory ${(base.peakMb / row.peakMb).toFixed(1)}x less` : ''}`);
writeFileSync(OUT, JSON.stringify({ seconds: SECONDS, repeats: REPEATS, rows }, null, 1));
