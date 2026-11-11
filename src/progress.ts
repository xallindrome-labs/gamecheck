import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const PROGRESS_VERSION = 1;
export const DEFAULT_PROGRESS_FILE = '.gamecheck/progress.json';

export interface ProgressResult {
  id: string;
  ok: boolean;
  /** Wall time the scenario took. */
  ms: number;
  /** First thing that went wrong, when it failed. */
  why?: string;
}

/** What a progress file holds. A panel, a CI log, or anything else can poll it; it is rewritten whole, never appended. */
export interface ProgressSnapshot {
  version: typeof PROGRESS_VERSION;
  runId: string;
  label: string;
  state: 'running' | 'done';
  startedAt: number;
  updatedAt: number;
  total: number;
  finished: number;
  passed: number;
  failed: number;
  /** The scenario in flight. Absent between scenarios and when the run is done. */
  current?: {
    id: string;
    proves?: string;
    /** opening: waiting for the lock or the browser; running: playing steps. */
    phase: 'opening' | 'running';
    startedAt: number;
    stepIndex: number;
    stepCount: number;
    step: string;
    /** Game time advanced so far in this scenario, in ms. */
    gameMs: number;
  };
  /** The last few results, newest last. */
  recent: ProgressResult[];
  failures: ProgressResult[];
}

export interface ProgressOptions {
  file: string;
  /** How many scenarios the run will play (0 when unknown). */
  total: number;
  label?: string;
  /** How many results `recent` keeps (default 8). */
  keep?: number;
  /** Writes between begin/end calls are spaced at least this far apart (default 250 ms). */
  minIntervalMs?: number;
}

/**
 * Writes a progress file as a run goes. Best effort by design: a failed write is dropped, never thrown, because a
 * panel must not be able to break a test run. The file is replaced atomically so a reader never sees half of it.
 */
export class Progress {
  private snapshot: ProgressSnapshot;
  private lastWrite = 0;
  private pending: NodeJS.Timeout | undefined;
  private readonly file: string;
  private readonly keep: number;
  private readonly minIntervalMs: number;

  constructor(options: ProgressOptions) {
    this.file = options.file;
    this.keep = options.keep ?? 8;
    this.minIntervalMs = options.minIntervalMs ?? 250;
    const now = Date.now();
    this.snapshot = {
      version: PROGRESS_VERSION, runId: `${now.toString(36)}-${process.pid}`, label: options.label ?? 'gamecheck', state: 'running',
      startedAt: now, updatedAt: now, total: options.total, finished: 0, passed: 0, failed: 0, recent: [], failures: [],
    };
    this.write(true);
  }

  /** A scenario is about to open: shows as "opening" until its first step. */
  begin(scenario: { id: string; proves?: string; steps: unknown[] }): void {
    this.snapshot.current = { id: scenario.id, proves: scenario.proves, phase: 'opening', startedAt: Date.now(), stepIndex: 0, stepCount: scenario.steps.length, step: 'opening the page', gameMs: 0 };
    this.write(true);
  }

  /** The observer half: playScenario calls these. */
  step(index: number, count: number, label: string): void {
    const current = this.snapshot.current;
    if (!current) return;
    current.phase = 'running';
    current.stepIndex = index;
    current.stepCount = count;
    current.step = label;
    this.write(false);
  }

  tick(gameMs: number): void {
    const current = this.snapshot.current;
    if (!current) return;
    current.gameMs = Math.round(gameMs);
    this.write(false);
  }

  end(result: ProgressResult): void {
    const s = this.snapshot;
    s.finished += 1;
    if (result.ok) s.passed += 1;
    else { s.failed += 1; s.failures.push(result); }
    s.recent = [...s.recent, result].slice(-this.keep);
    delete s.current;
    this.write(true);
  }

  finish(): void {
    this.snapshot.state = 'done';
    delete this.snapshot.current;
    this.write(true);
  }

  private write(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastWrite < this.minIntervalMs) {
      // Too soon: remember it, and write the latest state once the interval is up, so a step that starts in a quiet
      // moment still reaches the file instead of being lost until the next change.
      if (!this.pending) {
        this.pending = setTimeout(() => { this.pending = undefined; this.write(true); }, this.minIntervalMs - (now - this.lastWrite) + 5);
        this.pending.unref();
      }
      return;
    }
    if (this.pending) { clearTimeout(this.pending); this.pending = undefined; }
    this.lastWrite = now;
    this.snapshot.updatedAt = now;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.snapshot));
      renameSync(temp, this.file);
    } catch { /* a reader holding the file, a read-only folder: drop this write */ }
  }
}

/**
 * The file a run reports to. An explicit path wins, then GAMECHECK_PROGRESS (the value "off" turns progress off for
 * everything). With neither: none, unless the caller reports by default (the MCP server does) or `explicit` is true.
 */
export function progressFile(explicit?: string | boolean, options: { onByDefault?: boolean } = {}): string | undefined {
  const env = process.env.GAMECHECK_PROGRESS;
  if (env === 'off') return undefined;
  if (typeof explicit === 'string') return explicit;
  if (env) return env;
  return explicit === true || options.onByDefault ? DEFAULT_PROGRESS_FILE : undefined;
}
