import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compact,
  countryFlag,
  countryName,
  delta,
  duration,
  percent,
} from '../src/lib/format.ts';

test('keeps small numbers exact and abbreviates large ones', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(1_284), '1,284');
  assert.equal(compact(9_999), '9,999');
  assert.equal(compact(24_910), '24.9k');
  assert.equal(compact(1_400_000), '1.4M');
});

test('survives a non-finite number instead of printing NaN', () => {
  assert.equal(compact(Number.NaN), '0');
  assert.equal(percent(Number.NaN), '—');
});

test('formats durations the way a person would say them', () => {
  assert.equal(duration(45), '45s');
  assert.equal(duration(165), '2m 45s');
  assert.equal(duration(3_900), '1h 5m');
});

test('a zero duration reads as a dash, not as 0s', () => {
  // "0s" on a stat card looks like a broken metric; a dash reads as no data.
  assert.equal(duration(0), '—');
});

test('reports change against the previous window', () => {
  assert.deepEqual(delta(110, 100), { ratio: 0.1, label: '+10%', direction: 'up' });
  assert.equal(delta(90, 100).label, '-10%');
  assert.equal(delta(100, 100).direction, 'flat');
});

test('a count rising from nothing is "new", not an infinite percentage', () => {
  const change = delta(42, 0);
  assert.equal(change.label, 'new');
  assert.equal(change.direction, 'up');
  assert.equal(change.ratio, null);
});

test('a rate rising from nothing is a dash, because "new" would be a lie', () => {
  // The bounce rate did not appear from nowhere — there was simply no traffic
  // to compute it from. Calling that a rise implies a trend that never existed.
  const change = delta(0.56, 0, 'rate');
  assert.equal(change.label, '—');
  assert.equal(change.direction, 'flat');
});

test('nothing to nothing is a dash either way', () => {
  assert.equal(delta(0, 0).label, '—');
  assert.equal(delta(0, 0, 'rate').label, '—');
});

test('formats percentages', () => {
  assert.equal(percent(0.574), '57%');
  assert.equal(percent(0.574, 1), '57.4%');
});

test('names and flags countries', () => {
  assert.equal(countryName('DE'), 'Germany');
  assert.equal(countryFlag('DE'), '🇩🇪');
});

test('an unrecognised country code degrades to the code itself', () => {
  // QQ is well-formed but unassigned; A1 is malformed and makes Intl throw.
  // Neither may take the countries table down or render as "undefined".
  assert.equal(countryName('QQ'), 'QQ');
  assert.equal(countryName('A1'), 'A1');
  assert.equal(countryFlag('not-a-code'), '');
});
