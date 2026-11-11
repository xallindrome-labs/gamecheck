import { FRAME_MS } from './clock.js';
import { capBytes, planInputs, roundFloats, summarizeWatch, type Sample, type TimedInput, type WatchSummary } from './state.js';
import { Progress, progressFile } from './progress.js';
import { openGame, type OpenOptions, type Session } from './session.js';

/** The most game time one call may advance, and the wall time one call may spend before it stops and says so. */
export const MAX_STEP_MS = 600_000;
export const DEFAULT_WALL_BUDGET_MS = 25_000;
const CHUNK_MS = 1000;

export interface StepOptions {
  /** Game milliseconds to advance, or frames (at 60 per second). Not with `until`. */
  ms?: number;
  frames?: number;
  /** Advance until this expression is true, polling every pollMs, for at most maxMs of game time. */
  until?: string;
  maxMs?: number;
  pollMs?: number;
  /** Key presses on the game clock, as offsets from the start of the step. Not with `until`. */
  inputs?: TimedInput[];
  /** Expressions read before and after the step; the result says which changed. */
  report?: Record<string, string>;
  wallBudgetMs?: number;
}

export interface StepResult {
  advancedMs: number;
  gameMs: number;
  predicateMet?: boolean;
  report?: { before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] };
  forcedReleases?: string[];
  wallBudgetExceeded?: boolean;
}

export interface StateOptions {
  /** Named expressions to read. Without it the page's own `window.__gamecheck.state()` is used, if it has one. */
  exprs?: Record<string, string>;
  maxBytes?: number;
  digits?: number;
}

export interface WatchOptions {
  exprs: Record<string, string>;
  ms: number;
  hz?: number;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * One open game that an agent steers step by step: it keeps its page, its clock and the run lock between calls, and lets
 * go of all three when closed or after sitting idle.
 */
export class Interactive {
  private session: Session | undefined;
  private gameMs = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private progress: Progress | undefined;
  private opened = 0;
  private calls = 0;

  constructor(private readonly idleMs = Number(process.env.GAMECHECK_IDLE_MS ?? 600_000)) {}

  get isOpen(): boolean {
    return this.session !== undefined;
  }

  /** Calls run one at a time, so two of them never touch the page together. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, this.idleMs);
    this.idleTimer.unref();
  }

  private need(label?: string): Session {
    if (!this.session) throw new Error('no game is open: call open first (it may have been closed after sitting idle)');
    this.touch();
    if (label && this.progress) {
      this.calls += 1;
      this.progress.step(this.calls, 0, label);
      this.progress.tick(this.session.gameMs);
    }
    return this.session;
  }

  open(options: Omit<OpenOptions, 'stepped'> & { stepped?: boolean }): Promise<{ engine: string; clock: string; idleCloseMs: number }> {
    return this.run(async () => {
      if (this.session) throw new Error('a game is already open: close it first');
      this.session = await openGame({ lockTimeoutMs: 20_000, ...options, stepped: options.stepped ?? true });
      this.gameMs = 0;
      this.touch();
      const file = progressFile(undefined, { onByDefault: true });
      if (file) {
        this.progress = new Progress({ file, total: 0, label: `gamecheck interactive (${this.session.clock.stepped ? 'stepped' : 'real clock'})` });
        this.progress.begin({ id: options.url ?? 'html page', steps: [] });
        this.opened = Date.now();
        this.calls = 0;
        this.progress.step(0, 0, 'open');
      }
      return { engine: options.engine, clock: this.session.clock.stepped ? 'stepped' : 'real', idleCloseMs: this.idleMs };
    });
  }

  private async read(session: Session, exprs: Record<string, string>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(exprs)) out[name] = await session.evaluate(`(${expression})`);
    return out;
  }

  step(options: StepOptions): Promise<StepResult> {
    return this.run(async () => {
      const session = this.need(options.until ? `step until ${options.until}`.slice(0, 48) : `step ${options.ms !== undefined ? `${options.ms} ms` : `${options.frames ?? 0} frames`}`);
      if (options.until && (options.ms !== undefined || options.frames !== undefined || options.inputs)) throw new Error('until cannot be combined with ms, frames or inputs');
      const started = Date.now();
      const budget = options.wallBudgetMs ?? DEFAULT_WALL_BUDGET_MS;
      const before = options.report ? await this.read(session, options.report) : undefined;
      let advanced = 0;
      let wallBudgetExceeded = false;
      const over = (): boolean => (wallBudgetExceeded = wallBudgetExceeded || Date.now() - started > budget);
      let predicateMet: boolean | undefined;
      let forcedReleases: string[] | undefined;

      if (options.until) {
        const poll = Math.max(10, options.pollMs ?? 50);
        const cap = Math.min(options.maxMs ?? 20_000, MAX_STEP_MS);
        predicateMet = false;
        while (advanced <= cap && !over()) {
          if (await session.evaluate<boolean>(`Boolean(${options.until})`)) { predicateMet = true; break; }
          await session.advance(poll);
          advanced += poll;
        }
      } else {
        const total = Math.min(options.ms ?? (options.frames ?? 0) * FRAME_MS, MAX_STEP_MS);
        if (!(total > 0)) throw new Error('give ms or frames greater than 0, or until');
        const plan = planInputs(options.inputs ?? [], total);
        forcedReleases = plan.forced.length ? plan.forced : undefined;
        const advanceTo = async (target: number): Promise<void> => {
          while (advanced < target && !over()) {
            const chunk = Math.min(CHUNK_MS, target - advanced);
            await session.advance(chunk);
            advanced += chunk;
          }
        };
        for (const event of plan.events) {
          await advanceTo(event.t);
          if (wallBudgetExceeded) break;
          if (event.type === 'down') await session.page.keyboard.down(event.key);
          else await session.page.keyboard.up(event.key);
        }
        if (wallBudgetExceeded) for (const event of plan.events) await session.page.keyboard.up(event.key).catch(() => {});
        else await advanceTo(total);
      }

      this.gameMs += advanced;
      const result: StepResult = { advancedMs: Math.round(advanced), gameMs: Math.round(this.gameMs) };
      if (predicateMet !== undefined) result.predicateMet = predicateMet;
      if (forcedReleases) result.forcedReleases = forcedReleases;
      if (wallBudgetExceeded) result.wallBudgetExceeded = true;
      if (before && options.report) {
        const after = await this.read(session, options.report);
        result.report = { before, after, changed: Object.keys(after).filter((name) => !same(before[name], after[name])) };
      }
      return result;
    });
  }

  state(options: StateOptions = {}): Promise<{ state: unknown; truncated: boolean; dropped: number }> {
    return this.run(async () => {
      const session = this.need('read state');
      let raw: unknown;
      if (options.exprs) raw = await this.read(session, options.exprs);
      else {
        const offered = await session.evaluate<boolean>("typeof window.__gamecheck === 'object' && typeof window.__gamecheck.state === 'function'");
        if (!offered) throw new Error('give exprs, or have the page offer window.__gamecheck = { state() { return {...} } }');
        raw = await session.evaluate('window.__gamecheck.state()');
      }
      const capped = capBytes(roundFloats(raw, options.digits ?? 2), options.maxBytes ?? 2000);
      return { state: capped.value, truncated: capped.truncated, dropped: capped.dropped };
    });
  }

  watch(options: WatchOptions): Promise<WatchSummary & { samples: number }> {
    return this.run(async () => {
      const session = this.need('watch');
      const interval = Math.max(FRAME_MS, 1000 / Math.min(60, Math.max(1, options.hz ?? 10)));
      const total = Math.min(options.ms, MAX_STEP_MS);
      const series: Record<string, Sample[]> = Object.fromEntries(Object.keys(options.exprs).map((name) => [name, []]));
      let t = 0;
      const sample = async (): Promise<void> => {
        const values = await this.read(session, options.exprs);
        for (const [name, v] of Object.entries(values)) series[name]?.push({ t: Math.round(t), v });
      };
      await sample();
      while (t < total) {
        const chunk = Math.min(interval, total - t);
        await session.advance(chunk);
        t += chunk;
        this.gameMs += chunk;
        await sample();
      }
      return { ...summarizeWatch(series), samples: (series[Object.keys(series)[0] ?? '']?.length) ?? 0 };
    });
  }

  screenshot(maxWidth = 900): Promise<{ png: Buffer; width: number; height: number }> {
    return this.run(async () => {
      const session = this.need();
      const size = session.page.viewportSize() ?? { width: 1280, height: 720 };
      const scale = Math.min(1, maxWidth / size.width);
      const png = await session.page.screenshot({ type: 'png', scale: 'css', clip: { x: 0, y: 0, width: size.width, height: size.height } });
      return { png: scale < 1 ? await this.shrink(png, size.width, size.height, maxWidth) : png, width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
    });
  }

  private async shrink(png: Buffer, width: number, height: number, maxWidth: number): Promise<Buffer> {
    const session = this.need();
    const scale = maxWidth / width;
    const data = await session.page.evaluate(async ([base64, w, h]) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('decode')); image.src = `data:image/png;base64,${base64}`; });
      const canvas = document.createElement('canvas');
      canvas.width = w as number;
      canvas.height = h as number;
      canvas.getContext('2d')?.drawImage(image, 0, 0, w as number, h as number);
      return canvas.toDataURL('image/png').split(',')[1] ?? '';
    }, [png.toString('base64'), Math.round(width * scale), Math.round(height * scale)] as const);
    return Buffer.from(data, 'base64');
  }

  close(): Promise<{ closed: boolean }> {
    return this.run(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const session = this.session;
      this.session = undefined;
      if (!session) return { closed: false };
      this.progress?.tick(session.gameMs);
      await session.close();
      this.progress?.end({ id: 'interactive', ok: true, ms: Date.now() - this.opened });
      this.progress?.finish();
      this.progress = undefined;
      return { closed: true };
    });
  }
}
