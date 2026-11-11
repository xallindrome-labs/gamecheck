import { seededRandom } from './random.js';
import { openGame, type OpenOptions, type Session } from './session.js';

export type Step =
  | { do: 'advance'; ms: number }
  | { do: 'key'; key: string; ms?: number }
  | { do: 'eval'; expr: string; as?: string }
  | { do: 'waitFor'; expr: string; timeoutMs?: number; pollMs?: number }
  | { do: 'snapshot'; as: string; expr: string }
  /**
   * Advances until the expression is true and records how long it took, in game time: { ms, capped, stalled }. The
   * fight-length table: "until the boss is dead", capped, and stalled when the progress expression stops changing.
   */
  | { do: 'measure'; until: string; as: string; capMs?: number; pollMs?: number; progress?: string; stallMs?: number }
  /**
   * Plays on for ms of game time, checking an invariant every pollMs and, if given, pressing a seeded random key every
   * everyMs. Records { ok, violatedAtMs, seed, presses }: a softlock or out-of-bounds hunt that replays from its seed.
   */
  | { do: 'soak'; ms: number; invariant: string; as: string; pollMs?: number; inputs?: { keys: string[]; seed?: number; everyMs?: number; holdMs?: number } };

export interface Expectation {
  at: string;
  /** Dotted path into the snapshot; empty means the snapshot itself. */
  path?: string;
  equals?: unknown;
  oneOf?: unknown[];
  min?: number;
  max?: number;
  why: string;
}

export interface Scenario {
  id: string;
  /** What the scenario shows. */
  proves?: string;
  url?: string;
  html?: string;
  engine?: OpenOptions['engine'];
  gameRef?: string;
  /** Phaser engine: false steps without drawing. */
  render?: boolean;
  steps: Step[];
  expect: Expectation[];
}

export interface Observation {
  why: string;
  ok: boolean;
  actual: unknown;
  expected: Record<string, unknown>;
}

export interface ScenarioRecord {
  id: string;
  clock: 'stepped' | 'real';
  ok: boolean;
  ms: number;
  error?: string;
  observations: Observation[];
  recorded: Record<string, unknown>;
}

export function valueAt(value: unknown, path = ''): unknown {
  let at: unknown = value ?? null;
  for (const part of path ? path.split('.') : []) {
    if (at === null || typeof at !== 'object') return null;
    at = Array.isArray(at) && part === 'length' ? at.length : (at as Record<string, unknown>)[part] ?? null;
  }
  return at;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function judge(expectation: Expectation, recorded: Record<string, unknown>): Observation {
  const actual = valueAt(recorded[expectation.at], expectation.path);
  let ok = true;
  const expected: Record<string, unknown> = {};
  if ('equals' in expectation) { ok &&= same(actual, expectation.equals); expected.equals = expectation.equals; }
  if (expectation.oneOf) { ok &&= expectation.oneOf.some((one) => same(actual, one)); expected.oneOf = expectation.oneOf; }
  if (expectation.min !== undefined) { ok &&= typeof actual === 'number' && actual >= expectation.min; expected.min = expectation.min; }
  if (expectation.max !== undefined) { ok &&= typeof actual === 'number' && actual <= expectation.max; expected.max = expectation.max; }
  return { why: expectation.why, ok, actual, expected };
}

async function measure(session: Session, step: Extract<Step, { do: 'measure' }>): Promise<{ ms: number; capped: boolean; stalled: boolean }> {
  const { capMs = 900_000, pollMs = 100, stallMs } = step;
  const truthy = (expression: string): Promise<boolean> => session.evaluate<boolean>(`Boolean(${expression})`);
  let ms = 0;
  let last: number | undefined;
  let changedAt = 0;
  while (!(await truthy(step.until))) {
    if (ms >= capMs) return { ms, capped: true, stalled: false };
    if (step.progress && stallMs) {
      const now = await session.evaluate<number>(step.progress);
      if (last === undefined || now !== last) { last = now; changedAt = ms; }
      else if (ms - changedAt >= stallMs) return { ms, capped: false, stalled: true };
    }
    await session.advance(pollMs);
    ms += pollMs;
  }
  return { ms, capped: false, stalled: false };
}

async function soak(session: Session, step: Extract<Step, { do: 'soak' }>): Promise<{ ok: boolean; violatedAtMs: number | null; seed: number | null; presses: number }> {
  const { pollMs = 100, inputs } = step;
  const seed = inputs ? inputs.seed ?? 1 : null;
  const random = seededRandom(seed ?? 1);
  const everyMs = inputs?.everyMs ?? 500;
  let ms = 0;
  let nextPressAt = 0;
  let presses = 0;
  while (ms < step.ms) {
    if (!(await session.evaluate<boolean>(`Boolean(${step.invariant})`))) return { ok: false, violatedAtMs: ms, seed, presses };
    if (inputs && inputs.keys.length && ms >= nextPressAt) {
      const key = inputs.keys[Math.floor(random() * inputs.keys.length)] ?? inputs.keys[0] ?? '';
      const hold = inputs.holdMs ?? 120;
      await session.press(key, hold);
      presses += 1;
      ms += hold;
      nextPressAt = ms + everyMs;
    } else {
      await session.advance(pollMs);
      ms += pollMs;
    }
  }
  return { ok: true, violatedAtMs: null, seed, presses };
}

/** Told where a scenario is while it plays. `Progress` implements it; anything else can. */
export interface ScenarioObserver {
  step?(index: number, count: number, label: string): void;
  /** Called about twice a second of real time with the game time advanced so far. */
  tick?(gameMs: number): void;
}

const clip = (text: string, max = 48): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A short human label for a step, for progress displays. */
export function describeStep(step: Step): string {
  switch (step.do) {
    case 'advance': return `advance ${step.ms} ms`;
    case 'key': return `press ${step.key}`;
    case 'eval': return `eval ${clip(step.expr)}`;
    case 'waitFor': return `wait for ${clip(step.expr)}`;
    case 'snapshot': return `snapshot ${step.as}`;
    case 'measure': return `measure ${step.as}: until ${clip(step.until)}`;
    case 'soak': return `soak ${step.as}: ${step.ms} ms`;
  }
}

export async function playScenario(session: Session, scenario: Scenario, observer?: ScenarioObserver): Promise<ScenarioRecord> {
  const started = Date.now();
  const recorded: Record<string, unknown> = {};
  let error: string | undefined;
  const ticker = observer?.tick ? setInterval(() => observer.tick?.(session.gameMs), 500) : undefined;
  try {
    for (const [index, step] of scenario.steps.entries()) {
      observer?.step?.(index + 1, scenario.steps.length, describeStep(step));
      if (step.do === 'advance') await session.advance(step.ms);
      else if (step.do === 'key') await session.press(step.key, step.ms);
      else if (step.do === 'waitFor') await session.until(step.expr, step);
      else if (step.do === 'eval') { const value = await session.evaluate(step.expr); if (step.as) recorded[step.as] = value; }
      else if (step.do === 'measure') recorded[step.as] = await measure(session, step);
      else if (step.do === 'soak') recorded[step.as] = await soak(session, step);
      else recorded[step.as] = await session.evaluate(step.expr);
    }
  } catch (caught) {
    error = String((caught as Error).message ?? caught).split('\n')[0];
  } finally {
    if (ticker) clearInterval(ticker);
  }
  observer?.tick?.(session.gameMs);
  const observations = error ? [] : scenario.expect.map((expectation) => judge(expectation, recorded));
  return {
    id: scenario.id, clock: session.clock.stepped ? 'stepped' : 'real', ok: !error && observations.every((one) => one.ok),
    ms: Date.now() - started, ...(error ? { error } : {}), observations, recorded,
  };
}

/** Opens the scenario's page, plays it, and closes the browser, whatever happens. */
export async function runScenario(scenario: Scenario, options: Partial<OpenOptions> & { stepped: boolean }, observer?: ScenarioObserver): Promise<ScenarioRecord> {
  const session = await openGame({
    url: scenario.url, html: scenario.html, engine: scenario.engine ?? 'raf', gameRef: scenario.gameRef, render: scenario.render, ...options,
  });
  try {
    return await playScenario(session, scenario, observer);
  } finally {
    await session.close();
  }
}

export interface Comparison {
  id: string;
  equivalent: boolean;
  real: ScenarioRecord;
  stepped: ScenarioRecord;
  differences: string[];
}

/** Plays a scenario on the real clock and on the stepped one, and lists what differs: the verdicts and every observed value. */
export async function compareClocks(scenario: Scenario, options: Partial<OpenOptions> = {}): Promise<Comparison> {
  const real = await runScenario(scenario, { ...options, stepped: false });
  const stepped = await runScenario(scenario, { ...options, stepped: true });
  const differences: string[] = [];
  if (real.ok !== stepped.ok) differences.push(`verdict: real ${real.ok ? 'pass' : 'fail'}, stepped ${stepped.ok ? 'pass' : 'fail'}`);
  if (real.error !== stepped.error) differences.push(`error: real ${real.error ?? 'none'}, stepped ${stepped.error ?? 'none'}`);
  scenario.expect.forEach((expectation, index) => {
    const a = real.observations[index];
    const b = stepped.observations[index];
    if (a && b && !same(a.actual, b.actual)) differences.push(`${expectation.why}: real ${JSON.stringify(a.actual)}, stepped ${JSON.stringify(b.actual)}`);
  });
  return { id: scenario.id, equivalent: differences.length === 0, real, stepped, differences };
}
