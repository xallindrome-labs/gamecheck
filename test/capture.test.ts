import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureScenario, type AudioCue, type CaptureResult, type CaptureShot } from '../src/index.js';
import { serve } from './fixtures.js';

const ffmpeg = process.env.GAMECHECK_FFMPEG || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const skip = available ? false : 'ffmpeg missing: install it on PATH or set GAMECHECK_FFMPEG';
const sample = JSON.parse(readFileSync(new URL('../../examples/capture.json', import.meta.url), 'utf8')) as CaptureShot;
const temp = (): string => {
  const parent = resolve('.gamecheck');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'capture-test-'));
};
const cues = (result: CaptureResult): AudioCue[] => JSON.parse(readFileSync(result.cues, 'utf8')) as AudioCue[];
const wav = (result: CaptureResult): { seconds: number; peak(from: number, to: number): number } => {
  const bytes = readFileSync(result.audio);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  const rate = bytes.readUInt32LE(24);
  const channels = bytes.readUInt16LE(22);
  const frames = bytes.readUInt32LE(40) / (channels * 2);
  return {
    seconds: frames / rate,
    peak(from, to) {
      let peak = 0;
      for (let i = Math.max(0, Math.floor(from * rate)); i < Math.min(frames, to * rate); i += 1) peak = Math.max(peak, Math.abs(bytes.readInt16LE(44 + i * channels * 2)));
      return peak / 32767;
    },
  };
};
const video = (result: CaptureResult): { frames: number; width: number; height: number } => {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', result.video, '-map', '0:v:0', '-progress', 'pipe:1', '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const size = /Video:.*?, (\d+)x(\d+)(?:\s|,)/.exec(probe.stderr);
  const counts = [...probe.stdout.matchAll(/^frame=(\d+)/gm)];
  return { frames: Number(counts.at(-1)?.[1]), width: Number(size?.[1]), height: Number(size?.[2]) };
};

test('capture: two seconds of 30 fps footage, aligned cues and non-silent WAV', { skip }, async () => {
  const out = temp();
  try {
    const result = await captureScenario(sample, { out, mux: true });
    const info = video(result);
    assert.ok(Math.abs(info.frames - 60) <= 1, `got ${info.frames} frames`);
    assert.equal(info.width, 320);
    assert.equal(info.height, 180);
    assert.equal(result.seconds, 2);
    assert.equal(result.cueCount, 3);
    const pixels = spawnSync(ffmpeg, ['-loglevel', 'error', '-i', result.video, '-vf', 'select=eq(n\\,0)+eq(n\\,30)+eq(n\\,59)', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert.equal(pixels.status, 0, pixels.stderr.toString());
    assert.equal(pixels.stdout.length, 3 * 320 * 180 * 3);
    for (const [index, x] of [67, 163, 64].entries()) {
      const at = index * 320 * 180 * 3 + (90 * 320 + x) * 3;
      assert.ok((pixels.stdout[at + 1] ?? 0) > 210, `sampled frame ${index} contains the moving dot`);
    }
    const sounds = cues(result);
    const audio = wav(result);
    assert.equal(audio.seconds, result.seconds);
    assert.equal(audio.peak(0, 0.4), 0);
    for (const [index, cue] of sounds.entries()) {
      assert.ok(Math.abs(cue.at - (index + 1) * 0.5) <= 1 / 30 + 1e-6, `cue ${index}: ${cue.at}`);
      assert.equal(cue.src, 'buffer:1');
      assert.ok(audio.peak(cue.at, cue.at + 0.1) > 0.1, `cue ${index} is audible`);
    }
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', result.video, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.match(probe.stderr, /Audio: aac/);
    assert.ok(readdirSync(out).every((file) => !file.startsWith('.gamecheck-frames-')), 'temporary frames removed');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('capture: pre-roll loops, gain, offset, rate and stop are rebuilt on virtual time', { skip }, async () => {
  const out = temp();
  try {
    const result = await captureScenario({
      id: 'loop', html: `<canvas width="160" height="90"></canvas><script>
const audio = new AudioContext();
const buffer = audio.createBuffer(1, 4800, 48000);
buffer.getChannelData(0).fill(0.5);
const source = audio.createBufferSource(); source.buffer = buffer; source.loop = true;
source.playbackRate.value = 2;
const gain = audio.createGain(); gain.gain.value = 0.25;
source.connect(gain).connect(audio.destination);
window.begin = () => { source.start(0, 0.02); setTimeout(() => source.stop(), 600); };
</script>`,
      capture: { from: 3 },
      steps: [{ do: 'eval', expr: 'window.begin()' }, { do: 'advance', ms: 200 }, { do: 'advance', ms: 1000 }], expect: [],
    }, { out });
    const [cue] = cues(result);
    assert.ok(cue);
    assert.ok(Math.abs(cue.at + 0.233333) < 1e-5);
    assert.equal(cue.offset, 0.02);
    assert.equal(cue.rate, 2);
    assert.equal(cue.gain, 0.25);
    assert.equal(cue.loop, true);
    const audio = wav(result);
    assert.ok(Math.abs(audio.peak(0.01, 0.3) - 0.125) < 0.001);
    assert.equal(audio.peak(0.4, 1), 0, 'loop stopped instead of continuing to the video end');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

function tone(): string {
  const bytes = Buffer.alloc(44 + 4800 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(9600, 40);
  for (let i = 0; i < 4800; i += 1) bytes.writeInt16LE(Math.round(Math.sin(i / 48000 * Math.PI * 880) * 10000), 44 + i * 2);
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}

test('capture: fetch/XHR decoded buffers retain URLs, including callback decodeAudioData', { skip }, async () => {
  const out = temp();
  const data = tone();
  try {
    const result = await captureScenario({
      id: 'decoded', html: `<canvas width="160" height="90"></canvas><script>
const audio = new AudioContext(); window.ready = false;
const url = ${JSON.stringify(data)};
const fetched = fetch(url).then(r => r.arrayBuffer()).then(b => audio.decodeAudioData(b));
const xhr = new Promise(resolve => { const request = new XMLHttpRequest(); request.open('GET', url); request.responseType = 'arraybuffer'; request.onload = () => audio.decodeAudioData(request.response, resolve); request.send(); });
Promise.all([fetched, xhr]).then(buffers => {
  window.ready = true;
  window.begin = () => buffers.forEach((buffer, i) => setTimeout(() => { const s = audio.createBufferSource(); s.buffer = buffer; s.connect(audio.destination); s.start(0, 0.01, 0.04); }, 100 + i * 200));
});
</script>`,
      steps: [{ do: 'waitFor', expr: 'window.ready' }, { do: 'eval', expr: 'window.begin()' }, { do: 'advance', ms: 500 }],
      capture: { from: 2 }, expect: [],
    }, { out });
    const sounds = cues(result);
    assert.equal(sounds.length, 2);
    for (const cue of sounds) { assert.equal(cue.src, data); assert.equal(cue.offset, 0.01); assert.ok(Math.abs((cue.duration ?? 0) - 0.04) < 1e-6); }
    assert.ok(wav(result).peak(0.05, 0.4) > 0.1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('capture: WebGL readback happens before its drawing buffer is cleared', { skip }, async () => {
  const out = temp();
  try {
    const result = await captureScenario({
      id: 'webgl', html: `<canvas width="160" height="90"></canvas><script>
const gl = document.querySelector('canvas').getContext('webgl');
function frame() { gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(frame); } requestAnimationFrame(frame);
</script>`,
      steps: [{ do: 'advance', ms: 200 }], expect: [],
    }, { out });
    const decoded = spawnSync(ffmpeg, ['-loglevel', 'error', '-i', result.video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.ok((decoded.stdout[0] ?? 0) > 240, 'first pixel is red, not an empty WebGL buffer');
    assert.ok((decoded.stdout[1] ?? 255) < 15);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('capture: screenshot fallback respects viewport and device scale; key/wait/measure/soak share the frame loop', { skip }, async () => {
  const out = temp();
  try {
    const result = await captureScenario({
      id: 'fallback', html: '<style>body{background:red}</style><script>window.ready = false; setTimeout(() => window.ready = true, 100);</script>',
      capture: { viewport: '160x90', scale: 2 },
      steps: [{ do: 'key', key: 'Space', ms: 100 }, { do: 'waitFor', expr: 'window.ready' }, { do: 'measure', until: 'true', as: 'ready' }, { do: 'soak', ms: 100, invariant: 'true', as: 'soaked' }], expect: [],
    }, { out });
    assert.deepEqual(video(result), { frames: 6, width: 320, height: 180 });
    assert.equal(wav(result).seconds, result.seconds);
    assert.equal(result.cueCount, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('capture: rejects extra draws and removes temporary frames on failure', { skip }, async () => {
  const out = temp();
  try {
    await assert.rejects(captureScenario({
      id: 'extra-draw', html: '<canvas></canvas>',
      steps: [{ do: 'eval', expr: 'document.createElement("canvas").getContext("2d").fillRect(0, 0, 10, 10)' }, { do: 'advance', ms: 100 }, { do: 'eval', expr: 'document.querySelector("canvas").getContext("2d").fillRect(0, 0, 10, 10)' }], expect: [],
    }, { out }), /must not draw an extra frame/);
    assert.deepEqual(readdirSync(out), []);
    await assert.rejects(captureScenario({ ...sample, capture: { from: 0 } }, { out }), /1-based/);
    await assert.rejects(captureScenario({ ...sample, id: '../escape' }, { out }), /filename/);
    await assert.rejects(captureScenario(sample, { out, fps: 0 }), /positive/);
    const previous = process.env.GAMECHECK_FFMPEG;
    process.env.GAMECHECK_FFMPEG = join(out, 'missing-ffmpeg');
    try { await assert.rejects(captureScenario(sample, { out }), /ffmpeg is unavailable.*GAMECHECK_FFMPEG/); }
    finally { if (previous === undefined) delete process.env.GAMECHECK_FFMPEG; else process.env.GAMECHECK_FFMPEG = previous; }
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('capture: Phaser uses its target rate, draws every game frame and captures Web Audio', { skip }, async () => {
  const out = temp();
  const site = await serve({ '/index.html': `<script src="/node_modules/phaser/dist/phaser.min.js"></script><script>
window.updated = 0; window.drawn = 0;
window.__GAME__ = new Phaser.Game({ type: Phaser.CANVAS, width: 160, height: 90, fps: { target: 30 }, audio: { noAudio: true }, scene: {
  create() {
    this.add.rectangle(80, 45, 160, 90, 0xff0000);
    this.sys.events.on('render', () => window.drawn++);
    const audio = new AudioContext(); const buffer = audio.createBuffer(1, 4800, 48000); buffer.getChannelData(0).fill(0.2);
    this.time.addEvent({ delay: 100, loop: true, callback: () => { const sound = audio.createBufferSource(); sound.buffer = buffer; sound.connect(audio.destination); sound.start(); } });
    window.ready = true;
  },
  update() { window.updated++; }
} });
</script>` });
  try {
    const result = await captureScenario({
      id: 'phaser', engine: 'phaser', gameRef: 'window.__GAME__', render: false, url: `${site.url}/index.html`, capture: { fps: 15 },
      steps: [{ do: 'eval', expr: 'window.updated = 0; window.drawn = 0' }, { do: 'advance', ms: 400 }, { do: 'snapshot', as: 'counts', expr: '({ updated: window.updated, drawn: window.drawn })' }],
      expect: [{ at: 'counts', path: 'updated', equals: 12, why: '30 Hz game stepped twelve times' }, { at: 'counts', path: 'drawn', equals: 12, why: 'drawing was forced on' }],
    }, { out, beforeStart: async (page) => { await page.waitForFunction('window.__GAME__.isRunning && window.ready'); } });
    assert.deepEqual(video(result), { frames: 6, width: 160, height: 90 });
    assert.ok(result.cueCount >= 3);
    assert.ok(wav(result).peak(0, 0.4) > 0.1);
  } finally { await site.close(); rmSync(out, { recursive: true, force: true }); }
});

test('capture: MCP returns output paths and counts as text, never images', { skip }, async () => {
  const out = temp();
  const client = new Client({ name: 'capture-test', version: '0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/src/mcp.js')], env: { ...(process.env as Record<string, string>), GAMECHECK_PROGRESS: 'off' }, stderr: 'ignore' }));
    const result = await client.callTool({ name: 'gamecheck_capture', arguments: { scenario: { ...sample, steps: [{ do: 'advance', ms: 100 }] }, out } });
    assert.ok(!result.isError, JSON.stringify(result));
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    assert.equal(content[0]?.type, 'text');
    const captured = JSON.parse(content[0]?.text ?? '') as CaptureResult;
    assert.equal(captured.frames, 3);
    assert.equal(captured.seconds, 0.1);
    assert.equal(captured.cueCount, 0);
    assert.deepEqual(Object.keys(captured).sort(), ['audio', 'cueCount', 'cues', 'frames', 'seconds', 'video']);
    assert.equal(readFileSync(captured.video).subarray(4, 8).toString('ascii'), 'ftyp');
  } finally { await client.close(); rmSync(out, { recursive: true, force: true }); }
});

test('capture: HTML media plays are logged and rebuilt when their URL is decodable', { skip }, async () => {
  const out = temp();
  const site = await serve({ '/index.html': `<canvas width="160" height="90"></canvas><script>
const media = new Audio(${JSON.stringify(tone())}); media.volume = 0.5;
window.begin = () => media.play();
</script>` });
  try {
    const result = await captureScenario({
      id: 'media', url: `${site.url}/index.html`,
      steps: [{ do: 'eval', expr: 'window.begin()' }, { do: 'advance', ms: 200 }], expect: [],
    }, { out });
    const sounds = cues(result);
    assert.equal(sounds.length, 1);
    assert.equal(sounds[0]?.gain, 0.5);
    assert.ok(wav(result).peak(0, 0.05) > 0.05);
  } finally { await site.close(); rmSync(out, { recursive: true, force: true }); }
});
