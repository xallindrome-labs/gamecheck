// Standalone copy of gamecheck's src/progress.ts, compiled, with no dependencies beyond Node.
// Writes gamecheck's live progress file (the one the Claude Code panel shows).
// Copy it into your own harness. test/integrations.test.ts fails if it drifts from the source.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const PROGRESS_VERSION = 1;
export const DEFAULT_PROGRESS_FILE = '.gamecheck/progress.json';
/**
 * Writes a progress file as a run goes. Best effort by design: a failed write is dropped, never thrown, because a
 * panel must not be able to break a test run. The file is replaced atomically so a reader never sees half of it.
 */
export class Progress {
    snapshot;
    lastWrite = 0;
    pending;
    file;
    keep;
    minIntervalMs;
    constructor(options) {
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
    begin(scenario) {
        this.snapshot.current = { id: scenario.id, proves: scenario.proves, phase: 'opening', startedAt: Date.now(), stepIndex: 0, stepCount: scenario.steps.length, step: 'opening the page', gameMs: 0 };
        this.write(true);
    }
    /** The observer half: playScenario calls these. */
    step(index, count, label) {
        const current = this.snapshot.current;
        if (!current)
            return;
        current.phase = 'running';
        current.stepIndex = index;
        current.stepCount = count;
        current.step = label;
        this.write(false);
    }
    tick(gameMs) {
        const current = this.snapshot.current;
        if (!current)
            return;
        current.gameMs = Math.round(gameMs);
        this.write(false);
    }
    end(result) {
        const s = this.snapshot;
        s.finished += 1;
        if (result.ok)
            s.passed += 1;
        else {
            s.failed += 1;
            s.failures.push(result);
        }
        s.recent = [...s.recent, result].slice(-this.keep);
        delete s.current;
        this.write(true);
    }
    finish() {
        this.snapshot.state = 'done';
        delete this.snapshot.current;
        this.write(true);
    }
    write(force) {
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
        if (this.pending) {
            clearTimeout(this.pending);
            this.pending = undefined;
        }
        this.lastWrite = now;
        this.snapshot.updatedAt = now;
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            const temp = `${this.file}.${process.pid}.tmp`;
            writeFileSync(temp, JSON.stringify(this.snapshot));
            renameSync(temp, this.file);
        }
        catch { /* a reader holding the file, a read-only folder: drop this write */ }
    }
}
/**
 * The file a run reports to. An explicit path wins, then GAMECHECK_PROGRESS (the value "off" turns progress off for
 * everything). With neither: none, unless the caller reports by default (the MCP server does) or `explicit` is true.
 */
export function progressFile(explicit, options = {}) {
    const env = process.env.GAMECHECK_PROGRESS;
    if (env === 'off')
        return undefined;
    if (typeof explicit === 'string')
        return explicit;
    if (env)
        return env;
    return explicit === true || options.onByDefault ? DEFAULT_PROGRESS_FILE : undefined;
}
