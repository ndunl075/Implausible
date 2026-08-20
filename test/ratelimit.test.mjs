import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../src/lib/ratelimit.ts';

function limiterAt(limit, windowMs = 60_000) {
  const clock = { now: 0 };
  return {
    limiter: new RateLimiter(limit, windowMs, () => clock.now),
    advance: (ms) => (clock.now += ms),
  };
}

test('allows exactly the configured number of requests', () => {
  const { limiter } = limiterAt(3);
  assert.deepEqual(
    [1, 2, 3].map(() => limiter.check('k').allowed),
    [true, true, true],
  );
  assert.equal(limiter.check('k').allowed, false);
});

test('counts down the remaining budget', () => {
  const { limiter } = limiterAt(3);
  assert.equal(limiter.check('k').remaining, 2);
  assert.equal(limiter.check('k').remaining, 1);
  assert.equal(limiter.check('k').remaining, 0);
});

test('reopens the window once it elapses', () => {
  const { limiter, advance } = limiterAt(2, 1000);
  limiter.check('k');
  limiter.check('k');
  assert.equal(limiter.check('k').allowed, false);

  advance(1000);
  assert.equal(limiter.check('k').allowed, true);
});

test('reports how long to wait', () => {
  const { limiter, advance } = limiterAt(1, 60_000);
  limiter.check('k');
  advance(20_000);

  const verdict = limiter.check('k');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.retryAfter, 40);
});

test('one noisy client cannot starve another', () => {
  const { limiter } = limiterAt(2);
  limiter.check('noisy');
  limiter.check('noisy');
  assert.equal(limiter.check('noisy').allowed, false);
  assert.equal(limiter.check('quiet').allowed, true);
});

test('sweeps expired windows instead of growing forever', () => {
  const { limiter, advance } = limiterAt(10, 1000);
  for (let i = 0; i < 500; i++) limiter.check(`key-${i}`);
  assert.equal(limiter.size, 500);

  advance(1001);
  limiter.check('fresh');
  assert.equal(limiter.size, 1);
});
