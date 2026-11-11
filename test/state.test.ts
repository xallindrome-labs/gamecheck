import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capBytes, planInputs, roundFloats, summarizeWatch } from '../src/index.js';

test('roundFloats: rounds decimals, leaves integers and other values alone, reaches into objects and lists', () => {
  assert.deepEqual(roundFloats({ x: 1.23456, n: 3, s: 'a', list: [0.005, 2], nested: { y: -0.3333 } }), { x: 1.23, n: 3, s: 'a', list: [0.01, 2], nested: { y: -0.33 } });
  assert.equal(roundFloats(Infinity), Infinity);
});

test('capBytes: leaves a small value whole, and cuts a big object or list with a dropped count', () => {
  assert.deepEqual(capBytes({ a: 1 }, 100), { value: { a: 1 }, truncated: false, dropped: 0 });
  const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, 'x'.repeat(20)]));
  const object = capBytes(big, 200);
  assert.equal(object.truncated, true);
  assert.ok(JSON.stringify(object.value).length <= 200);
  assert.equal(Object.keys(object.value as object).length + object.dropped, 50);
  const list = capBytes(Array.from({ length: 100 }, (_, i) => i), 50);
  assert.equal(list.truncated, true);
  assert.equal((list.value as number[]).length + list.dropped, 100);
});

test('summarizeWatch: a number gets start, end, min, max, mean, slope and where; a name gets its values and a timeline', () => {
  const hp = Array.from({ length: 11 }, (_, i) => ({ t: i * 100, v: 100 - i * 10 }));
  const state = ['idle', 'idle', 'attack', 'attack', 'idle'].map((v, i) => ({ t: i * 250, v }));
  const summary = summarizeWatch({ hp, state });
  const field = summary.fields.hp;
  assert.ok(field);
  assert.equal(field.start, 100);
  assert.equal(field.end, 0);
  assert.equal(field.min, 0);
  assert.equal(field.max, 100);
  assert.equal(field.slope, -100);
  assert.equal(field.maxAt, 0);
  assert.equal(field.minAt, 1000);
  assert.deepEqual(summary.fields.state?.values, ['idle', 'attack']);
  assert.deepEqual(summary.timeline.map((one) => [one.t, one.from, one.to]), [[500, 'idle', 'attack'], [1000, 'attack', 'idle']]);
});

test('summarizeWatch: the timeline is capped, and says how much it dropped', () => {
  const flicker = Array.from({ length: 300 }, (_, i) => ({ t: i * 10, v: i % 2 ? 'a' : 'b' }));
  const summary = summarizeWatch({ flicker }, 100);
  assert.equal(summary.timeline.length, 100);
  assert.equal(summary.droppedEvents, 299 - 100);
});

test('planInputs: orders events, releases before presses at the same instant, cuts a hold at the end, drops a late press', () => {
  const plan = planInputs([
    { key: 'a', atMs: 100, holdMs: 200 },
    { key: 'b', atMs: 300, holdMs: 100 },
    { key: 'c', atMs: 900, holdMs: 500 },
    { key: 'd', atMs: 2000 },
  ], 1000);
  assert.deepEqual(plan.events.map((event) => `${event.t}${event.type === 'down' ? 'v' : '^'}${event.key}`), ['100va', '300^a', '300vb', '400^b', '900vc', '1000^c']);
  assert.deepEqual(plan.forced, ['c']);
});
