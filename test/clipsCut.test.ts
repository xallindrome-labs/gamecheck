import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cutClips, cutWindow, verticalCrop } from '../src/clipsCut.js';

const ffmpeg = process.env.GAMECHECK_FFMPEG || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const skip = available ? false : 'ffmpeg missing: install it on PATH or set GAMECHECK_FFMPEG';

test('cutWindow: the moment sits one post-roll before the end, with the window kept inside the video', () => {
  assert.deepEqual(cutWindow(30, 3, 8, 3), { start: 19, length: 11 });
  assert.deepEqual(cutWindow(30, 3, 8, 1), { start: 19, length: 9 });
  assert.deepEqual(cutWindow(6, 3, 8, 3), { start: 0, length: 6 });
  assert.deepEqual(cutWindow(2, 3, 8, 3), { start: 0, length: 2 });
  assert.deepEqual(cutWindow(30, 3, 0, 0), { start: 27, length: 0 });
});

test('verticalCrop: a 9:16 box centred on screenX, even-sided and clamped to the frame', () => {
  assert.deepEqual(verticalCrop(1920, 1080), { w: 606, h: 1080, x: 657, y: 0 });
  assert.deepEqual(verticalCrop(1920, 1080, 0.5), { w: 606, h: 1080, x: 657, y: 0 });
  assert.deepEqual(verticalCrop(1920, 1080, 0), { w: 606, h: 1080, x: 0, y: 0 });
  assert.deepEqual(verticalCrop(1920, 1080, 1), { w: 606, h: 1080, x: 1314, y: 0 });
  assert.equal(verticalCrop(1920, 1080, 0.25).x, 177);
  assert.equal(verticalCrop(1920, 1080, 5).x, 657);
  assert.deepEqual(verticalCrop(400, 400), { w: 224, h: 400, x: 88, y: 0 });
  assert.deepEqual(verticalCrop(300, 1080), { w: 300, h: 532, x: 0, y: 274 });
});

function clip(file: string, seconds: number): void {
  const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
}

function probe(file: string): { seconds: number; width: number; height: number; audio: boolean } {
  const text = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const size = /Video:.*?, (\d+)x(\d+)/.exec(text);
  return { seconds: Number(time?.[1]) * 3600 + Number(time?.[2]) * 60 + Number(time?.[3]), width: Number(size?.[1]), height: Number(size?.[2]), audio: /Audio:/.test(text) };
}

test('cut: trims a clip to its moment, crops vertical, keeps audio, holds a spoiler clip, and skips what is done', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-clips-'));
  try {
    clip(join(dir, 'a.mp4'), 6);
    clip(join(dir, 'b.mp4'), 6);
    clip(join(dir, 'c.mp4'), 6);
    const record = (meta: Record<string, unknown>): string => JSON.stringify({ trigger: 'parry', meta, wallTime: 1, postRollMs: 1_000, also: [] });
    writeFileSync(join(dir, 'a.json'), record({ screenX: 0.9 }));
    writeFileSync(join(dir, 'b.json'), record({ hold: true }));

    const plan = await cutClips(dir, { before: 2, vertical: true, dryRun: true });
    assert.deepEqual(plan.held, ['b.mp4']);
    assert.deepEqual(plan.unmatched, ['c.mp4']);
    assert.equal(plan.cut.length, 1);
    assert.equal(existsSync(join(dir, 'cuts')), false);
    assert.equal(existsSync(join(dir, 'cut.json')), false);

    const first = await cutClips(dir, { before: 2 });
    assert.equal(first.failed.length, 0, JSON.stringify(first.failed));
    assert.deepEqual(first.cut.map((one) => one.video), ['a.mp4']);
    const flat = probe(join(dir, 'cuts', 'a.mp4'));
    assert.ok(Math.abs(flat.seconds - 3) < 0.4, `got ${flat.seconds} s`);
    assert.equal(flat.width, 320);
    assert.ok(flat.audio);
    assert.equal(existsSync(join(dir, 'cuts', 'b.mp4')), false);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'cut.json'), 'utf8')) as object), ['a.mp4']);

    const again = await cutClips(dir, { before: 2 });
    assert.deepEqual(again.done, ['a.mp4']);
    assert.equal(again.cut.length, 0);

    const tall = await cutClips(dir, { before: 2, vertical: true });
    assert.equal(tall.failed.length, 0, JSON.stringify(tall.failed));
    const vertical = probe(join(dir, 'cuts', 'a-vertical.mp4'));
    assert.equal(vertical.height, 180);
    assert.equal(vertical.width, 100);
    assert.ok(vertical.audio);
    assert.equal(tall.cut[0]?.crop?.x, 220);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
