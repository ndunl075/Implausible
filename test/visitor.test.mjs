import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SESSION_WINDOW_MS,
  SessionTracker,
  rateLimitKey,
  visitorId,
} from '../src/lib/visitor.ts';

const FP = {
  ip: '203.0.113.42',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  domain: 'shop.example.com',
};

const SALT_MON = 'monday-salt-'.padEnd(43, 'a');
const SALT_TUE = 'tuesday-salt-'.padEnd(43, 'b');

test('is deterministic within a single day', () => {
  assert.equal(visitorId(SALT_MON, FP), visitorId(SALT_MON, FP));
});

test('is unlinkable across days once the salt rotates', () => {
  assert.notEqual(
    visitorId(SALT_MON, FP),
    visitorId(SALT_TUE, FP),
    'the same person on the same device must not be recognisable tomorrow',
  );
});

test('separates visitors by ip, user agent and domain independently', () => {
  const base = visitorId(SALT_MON, FP);
  assert.notEqual(base, visitorId(SALT_MON, { ...FP, ip: '203.0.113.43' }));
  assert.notEqual(base, visitorId(SALT_MON, { ...FP, userAgent: 'curl/8.0' }));
  assert.notEqual(base, visitorId(SALT_MON, { ...FP, domain: 'other.example' }));
});

test('cannot be confused by field boundaries', () => {
  // Without separators, ip "1.2.3.4" + ua "5" would collide with "1.2.3.4" + "5"
  // split differently. The delimiters make that impossible.
  const a = visitorId(SALT_MON, { ip: '1.2', userAgent: '3.4', domain: 'd' });
  const b = visitorId(SALT_MON, { ip: '1', userAgent: '2.3.4', domain: 'd' });
  assert.notEqual(a, b);
});

test('never reveals the ip it was derived from', () => {
  const id = visitorId(SALT_MON, FP);
  assert.ok(!id.includes('203'), 'no fragment of the address may survive');
  assert.ok(!id.includes(FP.ip));
  assert.ok(!id.includes(FP.userAgent));
});

test('produces a compact, url-safe, fixed-width id', () => {
  const id = visitorId(SALT_MON, FP);
  assert.match(id, /^[A-Za-z0-9_-]{22}$/, '128 bits, base64url, no padding');
});

test('spreads distinct visitors without collisions', () => {
  const ids = new Set();
  for (let i = 0; i < 5000; i++) {
    ids.add(visitorId(SALT_MON, { ...FP, ip: `10.0.${i >> 8}.${i & 255}` }));
  }
  assert.equal(ids.size, 5000);
});

test('rate-limit keys are domain-independent and never equal a visitor id', () => {
  const key = rateLimitKey(SALT_MON, FP.ip);
  assert.equal(key, rateLimitKey(SALT_MON, FP.ip));
  assert.notEqual(key, visitorId(SALT_MON, FP));
  assert.notEqual(
    key,
    rateLimitKey(SALT_TUE, FP.ip),
    'rate-limit state must expire with the salt too',
  );
  assert.ok(!key.includes('203'));
});

/* ------------------------------- sessions -------------------------------- */

function trackerAt(start = 0) {
  const clock = { now: start };
  return {
    tracker: new SessionTracker(SESSION_WINDOW_MS, () => clock.now),
    advance: (ms) => (clock.now += ms),
  };
}

test('a visitor keeps one session while they stay active', () => {
  const { tracker, advance } = trackerAt();
  const first = tracker.assign('visitor-a');
  assert.equal(first.isNewSession, true);

  advance(29 * 60 * 1000);
  const second = tracker.assign('visitor-a');

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.isNewSession, false);
});

test('the window slides rather than snapping to a fixed bucket', () => {
  const { tracker, advance } = trackerAt();
  const start = tracker.assign('visitor-a');

  // Browsing steadily for two hours is one session, not four.
  for (let i = 0; i < 8; i++) {
    advance(15 * 60 * 1000);
    assert.equal(tracker.assign('visitor-a').sessionId, start.sessionId);
  }
});

test('a new session begins after the inactivity window', () => {
  const { tracker, advance } = trackerAt();
  const first = tracker.assign('visitor-a');

  advance(SESSION_WINDOW_MS + 1);
  const second = tracker.assign('visitor-a');

  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.isNewSession, true);
});

test('separate visitors never share a session', () => {
  const { tracker } = trackerAt();
  assert.notEqual(
    tracker.assign('visitor-a').sessionId,
    tracker.assign('visitor-b').sessionId,
  );
});

test('session ids look nothing like the visitor they belong to', () => {
  const { tracker } = trackerAt();
  const { sessionId } = tracker.assign('visitor-a');
  assert.match(sessionId, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(!sessionId.includes('visitor-a'));
});

test('expired sessions are swept instead of accumulating', () => {
  const { tracker, advance } = trackerAt();
  for (let i = 0; i < 500; i++) tracker.assign(`visitor-${i}`);
  assert.equal(tracker.size, 500);

  advance(SESSION_WINDOW_MS + 1);
  tracker.assign('visitor-fresh');

  assert.equal(tracker.size, 1, 'only the live session should remain');
});

test('sweeping keeps still-active visitors', () => {
  const { tracker, advance } = trackerAt();
  const stale = tracker.assign('idle-visitor');
  const active = tracker.assign('busy-visitor');

  advance(20 * 60 * 1000);
  tracker.assign('busy-visitor');
  advance(20 * 60 * 1000);

  const busyAgain = tracker.assign('busy-visitor');
  const idleAgain = tracker.assign('idle-visitor');

  assert.equal(busyAgain.sessionId, active.sessionId, 'still one visit');
  assert.notEqual(idleAgain.sessionId, stale.sessionId, 'idled out');
});
