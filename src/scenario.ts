import { openGame, type OpenOptions, type Session } from './session.js';

export type Step =
  | { do: 'advance'; ms: number }
  | { do: 'key'; key: string; ms?: number }
  | { do: 'eval'; expr: string; as?: string }
  | { do: 'waitFor'; expr: string; timeoutMs?: number; pollMs?: number }
  | { do: 'snapshot'; as: string; expr: string };

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
  steps: Step[];
  expect: Expectation[];
}

export interface Observation {
  why: string;
  ok: boolean;
  actual: unknown;
  expected: Record<string, unknown>;
}

export interface Record_ {
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

export async function playScenario(session: Session, scenario: Scenario): Promise<Record_> {
  const started = Date.now();
  const recorded: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    for (const step of scenario.steps) {
      if (step.do === 'advance') await session.advance(step.ms);
      else if (step.do === 'key') await session.press(step.key, step.ms);
      else if (step.do === 'waitFor') await session.until(step.expr, step);
      else if (step.do === 'eval') { const value = await session.evaluate(step.expr); if (step.as) recorded[step.as] = value; }
      else recorded[step.as] = await session.evaluate(step.expr);
    }
  } catch (caught) {
    error = String((caught as Error).message ?? caught).split('\n')[0];
  }
  const observations = error ? [] : scenario.expect.map((expectation) => judge(expectation, recorded));
  return {
    id: scenario.id, clock: session.clock.stepped ? 'stepped' : 'real', ok: !error && observations.every((one) => one.ok),
    ms: Date.now() - started, ...(error ? { error } : {}), observations, recorded,
  };
}

/** Opens the scenario's page, plays it, and closes the browser, whatever happens. */
export async function runScenario(scenario: Scenario, options: Partial<OpenOptions> & { stepped: boolean }): Promise<Record_> {
  const session = await openGame({
    url: scenario.url, html: scenario.html, engine: scenario.engine ?? 'raf', gameRef: scenario.gameRef, ...options,
  });
  try {
    return await playScenario(session, scenario);
  } finally {
    await session.close();
  }
}

export interface Comparison {
  id: string;
  equivalent: boolean;
  real: Record_;
  stepped: Record_;
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
