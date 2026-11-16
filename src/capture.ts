import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FRAME_MS } from './clock.js';
import { installCaptureAudio, type CaptureAudio } from './captureAudio.js';
import { playScenario, type Scenario, type ScenarioObserver } from './scenario.js';
import { openGame, type OpenOptions, type Session } from './session.js';

export type { AudioCue } from './captureAudio.js';

export interface CaptureSettings {
  from?: number;
  fps?: number;
  viewport?: string;
  scale?: number;
}

export interface CaptureShot extends Scenario {
  capture?: CaptureSettings;
}

export interface CaptureOptions {
  out?: string;
  fps?: number;
  mux?: boolean;
  gpu?: boolean;
  frameMs?: number;
  lock?: boolean;
  lockTimeoutMs?: number;
  beforeStart?: OpenOptions['beforeStart'];
}

export interface CaptureResult {
  video: string;
  audio: string;
  cues: string;
  seconds: number;
  frames: number;
  cueCount: number;
}

const execute = promisify(execFile);

function pageDrawGuard(): void {
  const holder = window as unknown as { __gamecheckReading?: boolean };
  const guard = (prototype: object, methods: string[]): void => {
    const table = prototype as Record<string, unknown>;
    for (const name of methods) {
      const original = table[name];
      if (typeof original !== 'function') continue;
      table[name] = function (this: unknown, ...args: unknown[]): unknown {
        if (holder.__gamecheckReading && (this as { canvas?: unknown }).canvas === document.querySelector('canvas')) throw new Error('capture steps must not draw an extra frame: use advance or key to drive time; eval and snapshot may read state or issue commands without drawing');
        return Reflect.apply(original, this, args);
      };
    }
  };
  guard(CanvasRenderingContext2D.prototype, ['clearRect', 'fillRect', 'strokeRect', 'fill', 'stroke', 'drawImage', 'putImageData', 'fillText', 'strokeText', 'reset']);
  guard(WebGLRenderingContext.prototype, ['clear', 'drawArrays', 'drawElements']);
  guard(WebGL2RenderingContext.prototype, ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'blitFramebuffer']);
}

/** Plays a shot with drawing on, saving every Nth game frame and rebuilding its sound. */
export async function captureScenario(shot: CaptureShot, options: CaptureOptions = {}, observer?: ScenarioObserver): Promise<CaptureResult> {
  if (!/^[\w][\w.-]*$/.test(shot.id) || shot.id === '.' || shot.id === '..') throw new Error('capture id must be a filename: letters, numbers, underscores, dots and hyphens');
  const settings = shot.capture ?? {};
  const from = settings.from ?? 1;
  const fps = options.fps ?? settings.fps ?? 30;
  const scale = settings.scale ?? 1;
  if (!Number.isInteger(from) || from < 1 || from > shot.steps.length) throw new Error('capture.from must name a step (1-based)');
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('capture.fps must be positive');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('capture.scale must be positive');
  if (options.frameMs !== undefined && (!Number.isFinite(options.frameMs) || options.frameMs <= 0)) throw new Error('capture frameMs must be positive');
  if (shot.engine !== undefined && shot.engine !== 'raf' && shot.engine !== 'phaser') throw new Error('capture engine must be raf or phaser');
  for (const step of shot.steps) {
    if (!['advance', 'key', 'eval', 'snapshot', 'waitFor', 'measure', 'soak'].includes(step.do)) throw new Error(`capture does not support step ${String(step.do)}: steps must not draw extra frames`);
  }
  const size = settings.viewport === undefined ? null : /^(\d+)x(\d+)$/.exec(settings.viewport);
  if (settings.viewport !== undefined && (!size || Number(size[1]) < 1 || Number(size[2]) < 1)) throw new Error('capture.viewport wants WIDTHxHEIGHT, such as 1280x720');
  const ffmpeg = process.env.GAMECHECK_FFMPEG || 'ffmpeg';
  try { await execute(ffmpeg, ['-version']); } catch (error) {
    throw new Error(`ffmpeg is unavailable: install it on PATH or set GAMECHECK_FFMPEG to its executable (${(error as Error).message})`);
  }
  const out = resolve(options.out ?? 'captures');
  await mkdir(out, { recursive: true });
  const temp = await mkdtemp(join(out, '.gamecheck-frames-'));
  let session: Session | undefined;
  let frameMs = options.frameMs ?? FRAME_MS;
  let frames = 0;
  let gameFrames = 0;
  let capturing = false;
  let first: number | undefined;
  try {
    const opening: OpenOptions = {
      url: shot.url, html: shot.html, engine: shot.engine ?? 'raf', gameRef: shot.gameRef,
      stepped: true, render: true, gpu: options.gpu, frameMs,
      lock: options.lock, lockTimeoutMs: options.lockTimeoutMs, deviceScaleFactor: scale,
      ...(size ? { viewport: { width: Number(size[1]), height: Number(size[2]) } } : {}),
      beforeLoad: async (context) => { await installCaptureAudio(context); await context.addInitScript(pageDrawGuard); },
      beforeStart: async (page) => {
        await options.beforeStart?.(page);
        if (opening.engine === 'phaser' && options.frameMs === undefined && shot.gameRef) {
          const gameFps = await page.evaluate((ref) => ((0, eval)(ref) as { loop: { targetFps: number } }).loop.targetFps, shot.gameRef);
          if (Number.isFinite(gameFps) && gameFps > 0) opening.frameMs = frameMs = 1000 / gameFps;
        }
        await page.evaluate(({ engine, ref }) => {
          const holder = window as unknown as { __gamecheckSaveFrame: boolean; __gamecheckJpeg: string | null; __gamecheckClock: { advance(ms: number, frame: number): Promise<void> } };
          const read = (): void => {
            if (!holder.__gamecheckSaveFrame) return;
            holder.__gamecheckSaveFrame = false;
            const canvas = document.querySelector('canvas');
            holder.__gamecheckJpeg = null;
            if (canvas?.width && canvas.height) {
              try { holder.__gamecheckJpeg = canvas.toDataURL('image/jpeg', 0.95); } catch { /* A tainted canvas needs a screenshot. */ }
            }
          };
          // Read WebGL before the browser clears a non-preserved drawing buffer at the end of this task.
          if (engine === 'raf') {
            const advance = holder.__gamecheckClock.advance;
            holder.__gamecheckClock.advance = async (ms, frame) => { await advance(ms, frame); read(); };
          } else {
            const game = (0, eval)(ref as string) as { step(time: number, delta: number): void };
            const step = game.step;
            game.step = function (time, delta) { step.call(this, time, delta); read(); };
          }
        }, { engine: opening.engine, ref: shot.gameRef });
      },
    };
    session = await openGame(opening);
    const game = session;
    if (!Number.isFinite(frameMs) || frameMs <= 0 || fps > 1000 / frameMs + 1e-6) throw new Error('capture.fps must not exceed the engine frame rate, and frameMs must be positive');
    const every = Math.max(1, Math.round(1000 / frameMs / fps));
    const advance = async (ms: number): Promise<void> => {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('capture step time must be finite and non-negative');
      for (let n = Math.max(1, Math.round(ms / frameMs)); n > 0; n -= 1) {
        const save = capturing && (gameFrames + 1) % every === 0;
        if (save) await game.page.evaluate(() => { (window as unknown as { __gamecheckSaveFrame: boolean }).__gamecheckSaveFrame = true; });
        await game.advance(frameMs);
        if (!capturing || ++gameFrames % every !== 0) continue;
        const data = await game.page.evaluate(() => (window as unknown as { __gamecheckJpeg: string | null }).__gamecheckJpeg);
        const file = join(temp, `${String(frames).padStart(6, '0')}.jpg`);
        if (data?.startsWith('data:image/jpeg;base64,')) await writeFile(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
        else await game.page.screenshot({ path: file, type: 'jpeg', quality: 95 });
        first ??= await game.page.evaluate(() => performance.now() / 1000);
        frames += 1;
      }
    };
    const stepped: Session = {
      ...game,
      get gameMs() { return game.gameMs; },
      get memoryExceeded() { return game.memoryExceeded; },
      advance,
      async press(key, ms = 80) {
        await game.page.keyboard.down(key);
        try { await advance(ms); } finally { await game.page.keyboard.up(key); }
      },
      async until(expression, { timeoutMs = 30_000, pollMs = 50 } = {}) {
        if (!(pollMs > 0) || !Number.isFinite(pollMs) || !(timeoutMs >= 0) || !Number.isFinite(timeoutMs)) throw new Error('capture waitFor needs finite timeoutMs and positive pollMs');
        let waited = 0;
        while (!(await stepped.evaluate(`Boolean(${expression})`))) {
          if (waited >= timeoutMs) throw new Error(`${expression}: not true within ${timeoutMs} ms`);
          await advance(pollMs);
          waited += pollMs;
        }
        return waited;
      },
      evaluate: <T>(expression: string) => game.page.evaluate(async (source) => {
        const holder = window as unknown as { __gamecheckReading: boolean };
        holder.__gamecheckReading = true;
        try { return await (0, eval)(source) as unknown; } finally { holder.__gamecheckReading = false; }
      }, expression) as Promise<T>,
    };
    const record = await playScenario(stepped, { ...shot, expect: shot.expect ?? [] }, {
      step(index, count, label) { capturing = index >= from; observer?.step?.(index, count, label); },
      tick: observer?.tick?.bind(observer),
    });
    if (!record.ok) throw new Error(record.error ?? `capture expectations failed: ${record.observations.filter((one) => !one.ok).map((one) => one.why).join('; ')}`);
    if (!frames || first === undefined) throw new Error('no frames were saved: the shot must advance game time at or after capture.from');
    const seconds = frames / fps;
    const audio = await game.page.evaluate(({ from, seconds, timeScale }) => (window as unknown as { __gamecheckAudio: CaptureAudio }).__gamecheckAudio.finish(from, seconds, timeScale), { from: first, seconds, timeScale: 1000 / frameMs / every / fps });
    const result: CaptureResult = {
      video: join(out, `${shot.id}.mp4`), audio: join(out, `${shot.id}.wav`), cues: join(out, `${shot.id}.cues.json`),
      seconds, frames, cueCount: audio.cues.length,
    };
    await writeFile(result.audio, Buffer.from(audio.wav, 'base64'));
    await writeFile(result.cues, `${JSON.stringify(audio.cues, null, 1)}\n`);
    await execute(ffmpeg, [
      '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(temp, '%06d.jpg'),
      ...(options.mux ? ['-i', result.audio] : []),
      // H.264 in yuv420p needs even sides; a canvas can be any size.
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p',
      ...(options.mux ? ['-c:a', 'aac', '-shortest'] : []), result.video,
    ]);
    return result;
  } finally {
    try { await session?.close(); } finally { await rm(temp, { recursive: true, force: true }); }
  }
}
