import type { Browser, BrowserContext, Page } from 'playwright';
import { FRAME_MS, createRealClock, createSteppedClock, installLoadTracker, installVirtualClock, type Clock, type Engine } from './clock.js';
import { takeLock } from './lock.js';

const SWIFTSHADER_ARGS = ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const GPU_ARGS: Record<string, string[]> = {
  win32: ['--mute-audio', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
  darwin: ['--mute-audio', '--ignore-gpu-blocklist', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
};

export interface OpenOptions {
  /** A page to load. Give one of url or html. */
  url?: string;
  html?: string;
  engine: Engine;
  gameRef?: string;
  /** Step the game by hand (fast, deterministic) or wait on the real clock. */
  stepped: boolean;
  /** Draw on the real GPU: faster for logic checks. The default, software rendering, is the one to trust for pixels. */
  gpu?: boolean;
  headed?: boolean;
  viewport?: { width: number; height: number };
  /** Hold the one-headless-run-at-a-time lock (default true). */
  lock?: boolean;
  /** Give up waiting for the lock after this long, with an error that names the holder. */
  lockTimeoutMs?: number;
  frameMs?: number;
  /** Phaser engine: false steps without drawing (Phaser's headlessStep). See ClockOptions.render. */
  render?: boolean;
  /** Wait for pending loads (network, image and audio decode, Wasm, IndexedDB) after the page loads, in game time. Default true; free when nothing is pending. */
  settle?: boolean;
  /** Runs after the page has loaded and before the clock starts: load a library, boot the game. */
  beforeStart?: (page: Page) => Promise<void>;
}

export interface SettleOptions {
  /** Frames in a row with no pending work that count as settled (default 3). */
  quietFrames?: number;
  /** Real time to wait before giving up on work that never finishes (default 5000). */
  timeoutMs?: number;
}

export interface UntilOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface Session {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly browser: Browser;
  readonly clock: Clock;
  advance(ms: number): Promise<void>;
  /**
   * Advances game time until loads the page started have finished and stayed quiet for a few frames. Costs no game time
   * when nothing is pending. Work that never finishes is abandoned after timeoutMs of real time (abandoned: true).
   */
  settle(options?: SettleOptions): Promise<{ advancedMs: number; abandoned: boolean }>;
  press(key: string, holdMs?: number): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Advances in steps of pollMs until the expression is truthy; the timeout counts the time advanced. */
  until(expression: string, options?: UntilOptions): Promise<number>;
  close(): Promise<void>;
}

export async function openGame(options: OpenOptions): Promise<Session> {
  if (!options.url && options.html === undefined) throw new Error('openGame needs a url or html');
  const release = options.lock === false ? () => {} : await takeLock(`gamecheck ${options.url ?? 'html'}`, options.lockTimeoutMs);
  let browser: Browser | undefined;
  try {
    const { chromium } = await import('playwright');
    const args = options.gpu ? GPU_ARGS[process.platform] ?? ['--mute-audio', '--ignore-gpu-blocklist'] : SWIFTSHADER_ARGS;
    browser = await chromium.launch({ headless: !options.headed, args });
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 720 } });
    if (options.stepped) await installLoadTracker(context);
    if (options.stepped && options.engine === 'raf') await installVirtualClock(context);
    const page = await context.newPage();
    if (options.url) await page.goto(options.url);
    else await page.setContent(options.html ?? '');
    await options.beforeStart?.(page);
    const clock = options.stepped ? createSteppedClock(page, { engine: options.engine, gameRef: options.gameRef, frameMs: options.frameMs, render: options.render }) : createRealClock();
    await clock.start();
    const opened = browser;
    const session: Session = {
      page, context, browser: opened, clock,
      advance: (ms) => clock.advance(ms),
      async settle({ quietFrames = 3, timeoutMs = 5000 } = {}) {
        const began = Date.now();
        let advancedMs = 0;
        let quiet = 0;
        for (;;) {
          const pending = await page.evaluate(() => (window as unknown as { __gamecheckPending?: () => number }).__gamecheckPending?.() ?? 0);
          if (pending === 0 && (advancedMs === 0 || (quiet += 1) >= quietFrames)) return { advancedMs, abandoned: false };
          if (pending > 0) quiet = 0;
          if (Date.now() - began > timeoutMs) return { advancedMs, abandoned: true };
          await clock.advance(FRAME_MS);
          advancedMs += FRAME_MS;
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      },
      async press(key, holdMs = 80) {
        await page.keyboard.down(key);
        await clock.advance(holdMs);
        await page.keyboard.up(key);
      },
      evaluate: (expression) => page.evaluate((source) => (0, eval)(source), expression) as Promise<never>,
      async until(expression, { timeoutMs = 30_000, pollMs = 50 } = {}) {
        let waited = 0;
        for (;;) {
          if (await page.evaluate((source) => Boolean((0, eval)(source)), expression)) return waited;
          if (waited >= timeoutMs) throw new Error(`${expression}: not true within ${timeoutMs} ms`);
          await clock.advance(pollMs);
          waited += pollMs;
          if (clock.stepped) await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
      async close() {
        await clock.stop().catch(() => {});
        await opened.close().catch(() => {});
        release();
      },
    };
    if (options.stepped && options.settle !== false) await session.settle();
    return session;
  } catch (error) {
    await browser?.close().catch(() => {});
    release();
    throw error;
  }
}
