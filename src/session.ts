import type { Browser, BrowserContext, Page } from 'playwright';
import { createRealClock, createSteppedClock, installVirtualClock, type Clock, type Engine } from './clock.js';
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
  frameMs?: number;
  /** Runs after the page has loaded and before the clock starts: load a library, boot the game. */
  beforeStart?: (page: Page) => Promise<void>;
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
  press(key: string, holdMs?: number): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Advances in steps of pollMs until the expression is truthy; the timeout counts the time advanced. */
  until(expression: string, options?: UntilOptions): Promise<number>;
  close(): Promise<void>;
}

export async function openGame(options: OpenOptions): Promise<Session> {
  if (!options.url && options.html === undefined) throw new Error('openGame needs a url or html');
  const release = options.lock === false ? () => {} : await takeLock(`gamecheck ${options.url ?? 'html'}`);
  let browser: Browser | undefined;
  try {
    const { chromium } = await import('playwright');
    const args = options.gpu ? GPU_ARGS[process.platform] ?? ['--mute-audio', '--ignore-gpu-blocklist'] : SWIFTSHADER_ARGS;
    browser = await chromium.launch({ headless: !options.headed, args });
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 720 } });
    if (options.stepped && options.engine === 'raf') await installVirtualClock(context);
    const page = await context.newPage();
    if (options.url) await page.goto(options.url);
    else await page.setContent(options.html ?? '');
    await options.beforeStart?.(page);
    const clock = options.stepped ? createSteppedClock(page, { engine: options.engine, gameRef: options.gameRef, frameMs: options.frameMs }) : createRealClock();
    await clock.start();
    const opened = browser;
    const session: Session = {
      page, context, browser: opened, clock,
      advance: (ms) => clock.advance(ms),
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
    return session;
  } catch (error) {
    await browser?.close().catch(() => {});
    release();
    throw error;
  }
}
