import type { BrowserContext, Page } from 'playwright';

export type Engine = 'phaser' | 'raf';

export interface ClockOptions {
  engine: Engine;
  /** A JS expression for the Phaser.Game instance in the page, such as `window.__GAME__`. Phaser engine only. */
  gameRef?: string;
  frameMs?: number;
}

export interface Clock {
  readonly stepped: boolean;
  start(): Promise<void>;
  advance(ms: number): Promise<void>;
  stop(): Promise<void>;
}

export const FRAME_MS = 1000 / 60;

/**
 * Runs in the page before any of its scripts. It wraps requestAnimationFrame, the timers, performance.now and
 * Date.now. Until the clock is started they pass straight through to the real ones, so the page loads normally.
 */
function pageClock(): void {
  type Timer = { at: number; every: number; fn: () => void };
  const real = {
    raf: window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame.bind(window),
    now: performance.now.bind(performance),
    date: Date.now.bind(Date),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
  const state = { virtual: false, vt: 0, perf0: 0, date0: 0, nextId: 1_000_000_000 };
  const timers = new Map<number, Timer>();
  const frames = new Map<number, FrameRequestCallback>();

  window.requestAnimationFrame = (callback) => {
    if (!state.virtual) return real.raf(callback);
    state.nextId += 1;
    frames.set(state.nextId, callback);
    return state.nextId;
  };
  window.cancelAnimationFrame = (id) => {
    if (!frames.delete(id)) real.caf(id);
  };
  const addTimer = (fn: () => void, delay: number | undefined, repeat: boolean): number => {
    state.nextId += 1;
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(state.nextId, { at: state.vt + ms, every: repeat ? Math.max(1, ms) : 0, fn });
    return state.nextId;
  };
  window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (!state.virtual || typeof fn !== 'function') return real.setTimeout(fn, delay, ...args);
    return addTimer(() => fn(...args), delay, false);
  }) as typeof window.setTimeout;
  window.setInterval = ((fn: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (!state.virtual || typeof fn !== 'function') return real.setInterval(fn, delay, ...args);
    return addTimer(() => fn(...args), delay, true);
  }) as typeof window.setInterval;
  const clear = (id: number | undefined, fallback: (id?: number) => void): void => {
    if (id === undefined || !timers.delete(id)) fallback(id);
  };
  window.clearTimeout = ((id?: number) => clear(id, real.clearTimeout)) as typeof window.clearTimeout;
  window.clearInterval = ((id?: number) => clear(id, real.clearInterval)) as typeof window.clearInterval;
  performance.now = () => (state.virtual ? state.perf0 + state.vt : real.now());
  Date.now = () => (state.virtual ? state.date0 + state.vt : real.date());

  const api = {
    start(): void {
      if (state.virtual) return;
      state.perf0 = real.now();
      state.date0 = real.date();
      state.vt = 0;
      state.virtual = true;
    },
    stop(): void {
      if (!state.virtual) return;
      state.virtual = false;
      for (const callback of frames.values()) real.raf(callback);
      frames.clear();
      for (const timer of timers.values()) real.setTimeout(timer.fn, Math.max(0, timer.at - state.vt));
      timers.clear();
    },
    async advance(ms: number, frame: number): Promise<void> {
      const count = Math.max(1, Math.round(ms / frame));
      for (let i = 0; i < count; i += 1) {
        state.vt += frame;
        for (;;) {
          let nextId = -1;
          let nextAt = Infinity;
          for (const [id, timer] of timers) if (timer.at <= state.vt + 1e-6 && timer.at < nextAt) { nextId = id; nextAt = timer.at; }
          const due = timers.get(nextId);
          if (!due) break;
          if (due.every > 0) due.at += due.every;
          else timers.delete(nextId);
          due.fn();
        }
        const now = state.perf0 + state.vt;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(now);
        await Promise.resolve();
      }
    },
  };
  (window as unknown as { __gamecheckClock: typeof api }).__gamecheckClock = api;
}

/**
 * Needed for the `raf` engine: call it on the context before the page loads. The clock is virtual from the page's first
 * line, so every timer and frame the game asks for is ours; nothing moves until advance() or until() is called.
 */
export async function installVirtualClock(context: BrowserContext): Promise<void> {
  await context.addInitScript(pageClock);
  await context.addInitScript(() => (window as unknown as { __gamecheckClock: { start(): void } }).__gamecheckClock.start());
}

export function createRealClock(): Clock {
  return {
    stepped: false,
    async start() {},
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async stop() {},
  };
}

export function createSteppedClock(page: Page, options: ClockOptions): Clock {
  const frame = options.frameMs ?? FRAME_MS;
  if (options.engine === 'raf') {
    return {
      stepped: true,
      async start() {
        const ok = await page.evaluate(() => Boolean((window as unknown as { __gamecheckClock?: unknown }).__gamecheckClock));
        if (!ok) throw new Error('the virtual clock is not in the page: call installVirtualClock(context) before the page loads');
        await page.evaluate(() => (window as unknown as { __gamecheckClock: { start(): void } }).__gamecheckClock.start());
      },
      advance: (ms) => page.evaluate(([span, size]) => (window as unknown as { __gamecheckClock: { advance(a: number, b: number): Promise<void> } }).__gamecheckClock.advance(span as number, size as number), [ms, frame]),
      stop: () => page.evaluate(() => (window as unknown as { __gamecheckClock: { stop(): void } }).__gamecheckClock.stop()),
    };
  }
  const ref = options.gameRef;
  if (!ref) throw new Error('the phaser engine needs gameRef, an expression for the Phaser.Game in the page, such as "window.__GAME__"');
  return {
    stepped: true,
    async start() {
      await page.evaluate(([expression, size]) => {
        const holder = window as unknown as { __gamecheckStep?: unknown };
        if (holder.__gamecheckStep) return;
        const game = (0, eval)(expression as string) as { loop: { sleep(): void }; };
        if (!game?.loop) throw new Error(`gameRef ${String(expression)} is not a Phaser.Game`);
        game.loop.sleep();
        const state = { vt: 0, frame: size as number, perf0: performance.now(), date0: Date.now(), perf: performance.now.bind(performance), date: Date.now };
        performance.now = () => state.perf0 + state.vt;
        Date.now = () => state.date0 + state.vt;
        holder.__gamecheckStep = state;
      }, [ref, frame]);
    },
    async advance(ms) {
      await page.evaluate(async ([expression, span]) => {
        const state = (window as unknown as { __gamecheckStep?: { vt: number; frame: number; perf0: number } }).__gamecheckStep;
        if (!state) throw new Error('the clock is not started');
        const game = (0, eval)(expression as string) as { step(time: number, delta: number): void };
        const count = Math.max(1, Math.round((span as number) / state.frame));
        for (let i = 0; i < count; i += 1) {
          state.vt += state.frame;
          game.step(state.perf0 + state.vt, state.frame);
          await Promise.resolve();
          if (i % 300 === 299) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }, [ref, ms]);
    },
    async stop() {
      await page.evaluate((expression) => {
        const holder = window as unknown as { __gamecheckStep?: { perf: () => number; date: () => number } | null };
        const state = holder.__gamecheckStep;
        if (!state) return;
        performance.now = state.perf;
        Date.now = state.date;
        holder.__gamecheckStep = null;
        ((0, eval)(expression as string) as { loop: { wake(): void } }).loop.wake();
      }, ref);
    },
  };
}
