import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ClipRecord } from './clips.js';
import { sidecarPath } from './clipsCollect.js';

const execute = promisify(execFile);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.flv', '.webm']);
const DEFAULT_POST_ROLL_S = 3;

export interface CutOptions {
  out?: string;
  before?: number;
  after?: number;
  vertical?: boolean;
  dryRun?: boolean;
}

export interface CutWindow {
  start: number;
  length: number;
}

export interface CropBox {
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface CutItem {
  video: string;
  out: string;
  start: number;
  length: number;
  crop?: CropBox;
}

export interface CutResult {
  cut: CutItem[];
  held: string[];
  done: string[];
  unmatched: string[];
  failed: { video: string; error: string }[];
  dryRun: boolean;
}

interface DoneEntry {
  out: string;
  vertical: boolean;
  before: number;
  after: number | null;
}

/** The moment sits postRollS before the end of the saved replay; keep `before` seconds ahead of it and `after` behind, inside the video. */
export function cutWindow(duration: number, postRollS: number, before: number, after: number): CutWindow {
  const at = Math.max(0, duration - postRollS);
  const start = Math.max(0, at - before);
  const end = Math.min(duration, at + after);
  return { start, length: Math.max(0, end - start) };
}

const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);

/** A 9:16 box centred on screenX (0 to 1 across the frame; the middle when missing), kept inside the frame. */
export function verticalCrop(width: number, height: number, screenX?: number): CropBox {
  let w = even(height * 9 / 16);
  let h = even(height);
  if (w > width) {
    w = even(width);
    h = Math.min(even(height), even(width * 16 / 9));
  }
  const centre = (typeof screenX === 'number' && screenX >= 0 && screenX <= 1 ? screenX : 0.5) * width;
  const x = Math.min(Math.max(0, Math.round(centre - w / 2)), width - w);
  return { w, h, x, y: Math.round((height - h) / 2) };
}

export function ffmpegPath(): string {
  return process.env.GAMECHECK_FFMPEG || 'ffmpeg';
}

async function probe(file: string): Promise<{ duration: number; width: number; height: number }> {
  let text: string;
  try {
    text = (await execute(ffmpegPath(), ['-hide_banner', '-i', file])).stderr;
  } catch (error) {
    const failure = error as { stderr?: string; code?: unknown; message: string };
    if (failure.code === 'ENOENT') throw new Error(`ffmpeg is unavailable: install it on PATH or set GAMECHECK_FFMPEG to its executable (${failure.message})`);
    text = failure.stderr ?? '';
  }
  const time = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const size = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(text);
  if (!time || !size) throw new Error(`could not read the length and size of ${basename(file)}`);
  return { duration: Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]), width: Number(size[1]), height: Number(size[2]) };
}

const isHeld = (record: ClipRecord): boolean => record.meta?.hold === true || (record.also ?? []).some((one) => one.meta?.hold === true);

/** Trims each video in the folder that has a sidecar to its moment. Clips whose meta says hold: true are listed and left alone. */
export async function cutClips(folder: string, options: CutOptions = {}): Promise<CutResult> {
  const root = resolve(folder);
  if (!existsSync(root)) throw new Error(`no such folder: ${folder}`);
  const out = resolve(options.out ?? join(root, 'cuts'));
  const before = options.before ?? 8;
  if (!(before >= 0) || (options.after !== undefined && !(options.after >= 0))) throw new Error('--before and --after must be zero or more seconds');
  const ledgerFile = join(root, 'cut.json');
  const ledger: Record<string, DoneEntry> = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) as Record<string, DoneEntry> : {};
  const result: CutResult = { cut: [], held: [], done: [], unmatched: [], failed: [], dryRun: Boolean(options.dryRun) };
  const videos = readdirSync(root).filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase())).sort();
  for (const name of videos) {
    const video = join(root, name);
    const sidecar = sidecarPath(video);
    if (!existsSync(sidecar)) { result.unmatched.push(name); continue; }
    try {
      const record = JSON.parse(readFileSync(sidecar, 'utf8')) as ClipRecord;
      if (isHeld(record)) { result.held.push(name); continue; }
      const postRoll = typeof record.postRollMs === 'number' ? record.postRollMs / 1000 : DEFAULT_POST_ROLL_S;
      const after = options.after ?? postRoll;
      const target = join(out, `${basename(name, extname(name))}${options.vertical ? '-vertical' : ''}.mp4`);
      const key = options.vertical ? `${name} (vertical)` : name;
      const seen = ledger[key];
      if (seen && seen.out === target && seen.vertical === Boolean(options.vertical) && seen.before === before && seen.after === (options.after ?? null) && existsSync(target)) {
        result.done.push(name);
        continue;
      }
      const info = await probe(video);
      const window = cutWindow(info.duration, postRoll, before, after);
      const screenX = record.meta?.screenX;
      const crop = options.vertical ? verticalCrop(info.width, info.height, typeof screenX === 'number' ? screenX : undefined) : undefined;
      const item: CutItem = { video: name, out: target, start: window.start, length: window.length, ...(crop ? { crop } : {}) };
      if (!options.dryRun) {
        mkdirSync(out, { recursive: true });
        await execute(ffmpegPath(), [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-ss', window.start.toFixed(3), '-i', video, '-t', window.length.toFixed(3),
          '-map', '0:v:0', '-map', '0:a?',
          ...(crop ? ['-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target,
        ]);
        ledger[key] = { out: target, vertical: Boolean(options.vertical), before, after: options.after ?? null };
        writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
      }
      result.cut.push(item);
    } catch (error) {
      result.failed.push({ video: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
