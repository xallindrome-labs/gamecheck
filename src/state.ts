/** Rounds every non-integer number in a value, so a state read spends few tokens on noise digits. */
export function roundFloats(value: unknown, digits = 2): unknown {
  if (typeof value === 'number') return Number.isFinite(value) && !Number.isInteger(value) ? Number(value.toFixed(digits)) : value;
  if (Array.isArray(value)) return value.map((one) => roundFloats(one, digits));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, roundFloats(one, digits)]));
  return value;
}

export interface Capped {
  value: unknown;
  truncated: boolean;
  /** How many keys or items were left out. */
  dropped: number;
}

const size = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

/** Keeps a value under a byte budget: an object keeps its first keys, a list its first items, and says what it dropped. */
export function capBytes(value: unknown, maxBytes: number): Capped {
  if (size(value) <= maxBytes) return { value, truncated: false, dropped: 0 };
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    for (const item of value) {
      if (size([...kept, item]) > maxBytes) break;
      kept.push(item);
    }
    return { value: kept, truncated: true, dropped: value.length - kept.length };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const kept: Array<[string, unknown]> = [];
    for (const entry of entries) {
      if (size(Object.fromEntries([...kept, entry])) > maxBytes) break;
      kept.push(entry);
    }
    return { value: Object.fromEntries(kept), truncated: true, dropped: entries.length - kept.length };
  }
  return { value: String(value).slice(0, maxBytes), truncated: true, dropped: 0 };
}

export interface Sample {
  /** Game milliseconds since the watch began. */
  t: number;
  v: unknown;
}

export interface FieldSummary {
  start: unknown;
  end: unknown;
  changes: number;
  min?: number;
  max?: number;
  mean?: number;
  /** Units per second, by least squares over the samples. */
  slope?: number;
  minAt?: number;
  maxAt?: number;
  /** The distinct values seen, for a field that is not a number (a state name, a flag). */
  values?: unknown[];
}

export interface WatchSummary {
  fields: Record<string, FieldSummary>;
  /** Changes of a field that is not a number, in time order. */
  timeline: Array<{ t: number; field: string; from: unknown; to: unknown }>;
  droppedEvents: number;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const round = (n: number): number => Math.round(n * 100) / 100;

/** A watch's samples reduced to a summary per field, so its size grows with the fields, not with the time watched. */
export function summarizeWatch(series: Record<string, Sample[]>, timelineCap = 100): WatchSummary {
  const fields: Record<string, FieldSummary> = {};
  const timeline: WatchSummary['timeline'] = [];
  for (const [field, samples] of Object.entries(series)) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) continue;
    let changes = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const before = samples[i - 1];
      const now = samples[i];
      if (before && now && !same(before.v, now.v)) {
        changes += 1;
        if (typeof now.v !== 'number') timeline.push({ t: now.t, field, from: before.v, to: now.v });
      }
    }
    const numbers = samples.filter((one): one is { t: number; v: number } => typeof one.v === 'number' && Number.isFinite(one.v));
    if (numbers.length === samples.length) {
      const values = numbers.map((one) => one.v);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const meanT = numbers.reduce((sum, one) => sum + one.t, 0) / numbers.length;
      const meanV = values.reduce((sum, v) => sum + v, 0) / values.length;
      const denominator = numbers.reduce((sum, one) => sum + (one.t - meanT) ** 2, 0);
      const slope = denominator > 0 ? (numbers.reduce((sum, one) => sum + (one.t - meanT) * (one.v - meanV), 0) / denominator) * 1000 : 0;
      fields[field] = {
        start: round(first.v as number), end: round(last.v as number), changes,
        min: round(min), max: round(max), mean: round(meanV), slope: round(slope),
        minAt: numbers.find((one) => one.v === min)?.t, maxAt: numbers.find((one) => one.v === max)?.t,
      };
    } else {
      const distinct: unknown[] = [];
      for (const one of samples) if (!distinct.some((seen) => same(seen, one.v)) && distinct.length < 8) distinct.push(one.v);
      fields[field] = { start: first.v, end: last.v, changes, values: distinct };
    }
  }
  timeline.sort((a, b) => a.t - b.t);
  return { fields, timeline: timeline.slice(0, timelineCap), droppedEvents: Math.max(0, timeline.length - timelineCap) };
}

export interface TimedInput {
  key: string;
  /** Game milliseconds from the start of the step. */
  atMs: number;
  holdMs?: number;
}

export interface InputEvent {
  t: number;
  type: 'down' | 'up';
  key: string;
}

/**
 * Turns a timeline of key presses into ordered down and up events inside a step window. At the same instant releases
 * come before presses, a hold that outlasts the window is cut at its end (and listed in `forced`), and a press that
 * starts after the window is left out.
 */
export function planInputs(inputs: TimedInput[], windowMs: number): { events: InputEvent[]; forced: string[] } {
  const events: InputEvent[] = [];
  const forced: string[] = [];
  for (const input of inputs) {
    if (input.atMs >= windowMs || input.atMs < 0) continue;
    const end = input.atMs + (input.holdMs ?? 80);
    events.push({ t: input.atMs, type: 'down', key: input.key });
    if (end > windowMs) forced.push(input.key);
    events.push({ t: Math.min(end, windowMs), type: 'up', key: input.key });
  }
  events.sort((a, b) => a.t - b.t || (a.type === b.type ? 0 : a.type === 'up' ? -1 : 1));
  return { events, forced };
}
