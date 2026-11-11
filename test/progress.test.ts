import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeStep, Progress, progressFile, type ProgressSnapshot } from '../src/index.js';

const read = (file: string): ProgressSnapshot => JSON.parse(readFileSync(file, 'utf8')) as ProgressSnapshot;

test('progress: a run is visible from the first write to the last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-progress-'));
  const file = join(dir, 'nested', 'progress.json');
  try {
    const progress = new Progress({ file, total: 2, label: 'unit', minIntervalMs: 0 });
    assert.equal(read(file).state, 'running');
    assert.equal(read(file).total, 2);

    progress.begin({ id: 'first', proves: 'a thing', steps: [1, 2, 3] });
    assert.deepEqual([read(file).current?.id, read(file).current?.phase, read(file).current?.stepCount], ['first', 'opening', 3]);

    progress.step(2, 3, 'advance 500 ms');
    progress.tick(1234.6);
    const mid = read(file).current;
    assert.deepEqual([mid?.phase, mid?.stepIndex, mid?.step, mid?.gameMs], ['running', 2, 'advance 500 ms', 1235]);

    progress.end({ id: 'first', ok: true, ms: 40 });
    progress.begin({ id: 'second', steps: [1] });
    progress.end({ id: 'second', ok: false, ms: 70, why: 'boss never died' });
    progress.finish();

    const done = read(file);
    assert.equal(done.state, 'done');
    assert.equal(done.current, undefined);
    assert.deepEqual([done.finished, done.passed, done.failed], [2, 1, 1]);
    assert.deepEqual(done.failures.map((one) => one.why), ['boss never died']);
    assert.deepEqual(done.recent.map((one) => one.id), ['first', 'second']);
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['progress.json'], 'no temp files left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('progress: writes between calls are throttled, results never are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-progress-'));
  const file = join(dir, 'progress.json');
  try {
    const progress = new Progress({ file, total: 1, minIntervalMs: 60_000 });
    progress.begin({ id: 'a', steps: [1, 2] });
    progress.tick(100);
    progress.tick(200);
    assert.equal(read(file).current?.gameMs, 0, 'ticks inside the interval are skipped');
    progress.end({ id: 'a', ok: true, ms: 1 });
    assert.equal(read(file).finished, 1, 'a result is always written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('progress: keeps only the last few results in recent, all failures in failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gamecheck-progress-'));
  const file = join(dir, 'progress.json');
  try {
    const progress = new Progress({ file, total: 12, keep: 3, minIntervalMs: 0 });
    for (let i = 0; i < 12; i += 1) {
      progress.begin({ id: `s${i}`, steps: [] });
      progress.end({ id: `s${i}`, ok: i % 4 !== 0, ms: 1 });
    }
    const snapshot = read(file);
    assert.deepEqual(snapshot.recent.map((one) => one.id), ['s9', 's10', 's11']);
    assert.deepEqual(snapshot.failures.map((one) => one.id), ['s0', 's4', 's8']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('progress: an unwritable path never throws into the run', () => {
  const progress = new Progress({ file: join(tmpdir(), 'gamecheck-no-such', '\0bad', 'p.json'), total: 1 });
  progress.begin({ id: 'a', steps: [] });
  progress.end({ id: 'a', ok: true, ms: 1 });
  progress.finish();
});

test('progress: file choice is opt-in, explicit first, then the environment', () => {
  const saved = process.env.GAMECHECK_PROGRESS;
  try {
    delete process.env.GAMECHECK_PROGRESS;
    assert.equal(progressFile(undefined), undefined);
    assert.equal(progressFile(true), '.gamecheck/progress.json');
    assert.equal(progressFile('mine.json'), 'mine.json');
    process.env.GAMECHECK_PROGRESS = 'env.json';
    assert.equal(progressFile(undefined), 'env.json');
    assert.equal(progressFile('mine.json'), 'mine.json');
  } finally {
    if (saved === undefined) delete process.env.GAMECHECK_PROGRESS;
    else process.env.GAMECHECK_PROGRESS = saved;
  }
});

test('describeStep: every step kind has a short label', () => {
  assert.equal(describeStep({ do: 'advance', ms: 500 }), 'advance 500 ms');
  assert.equal(describeStep({ do: 'key', key: 'ArrowRight' }), 'press ArrowRight');
  assert.equal(describeStep({ do: 'snapshot', as: 'after', expr: 'x' }), 'snapshot after');
  assert.ok(describeStep({ do: 'waitFor', expr: 'a'.repeat(200) }).length < 70);
  assert.match(describeStep({ do: 'measure', until: 'boss.dead', as: 'fight' }), /measure fight/);
  assert.match(describeStep({ do: 'soak', ms: 30000, invariant: 'ok', as: 'soak' }), /30000 ms/);
});
