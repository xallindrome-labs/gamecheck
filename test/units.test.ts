import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, seededRandom, valueAt } from '../src/index.js';

test('seededRandom: the same seed gives the same sequence, another seed another', () => {
  const take = (seed: number): number[] => {
    const next = seededRandom(seed);
    return Array.from({ length: 5 }, next);
  };
  assert.deepEqual(take(7), take(7));
  assert.notDeepEqual(take(7), take(8));
  assert.ok(take(1).every((value) => value >= 0 && value < 1));
});

test('valueAt: dotted paths, list length, and null for a missing step', () => {
  const state = { boss: { hp: 12, parts: ['a', 'b'] } };
  assert.equal(valueAt(state, 'boss.hp'), 12);
  assert.equal(valueAt(state, 'boss.parts.length'), 2);
  assert.equal(valueAt(state, 'boss.nope.deeper'), null);
});

test('judge: equals, oneOf, min and max', () => {
  const recorded = { s: { n: 5 } };
  assert.equal(judge({ at: 's', path: 'n', equals: 5, why: '' }, recorded).ok, true);
  assert.equal(judge({ at: 's', path: 'n', oneOf: [1, 5], why: '' }, recorded).ok, true);
  assert.equal(judge({ at: 's', path: 'n', min: 6, why: '' }, recorded).ok, false);
  assert.equal(judge({ at: 's', path: 'n', max: 5, why: '' }, recorded).ok, true);
});
