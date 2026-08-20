/**
 * Deriving the visitor and session identifiers.
 *
 * Invariant 1: the raw IP arrives as an argument, is mixed into an HMAC, and
 * goes out of scope. It is never returned, stored, logged, or included in an
 * error. Every function in this file takes the IP last and gives back an opaque
 * string, so there is no accessor that could leak it by accident.
 */
import { createHmac } from 'node:crypto';

/** 128 bits of output. Wide enough that collisions never shape a metric. */
const ID_BYTES = 16;

/** A session ends after this much inactivity. */
export const SESSION_WINDOW_MS = 30 * 60 * 1000;

/** How many idle visitors the session table will hold before it force-sweeps. */
const MAX_TRACKED_SESSIONS = 250_000;

export interface Fingerprint {
  ip: string;
  userAgent: string;
  domain: string;
}

/**
 * `visitor_id = hash(daily_salt + ip + user_agent + domain)`
 *
 * Implemented as HMAC-SHA256 keyed by the salt rather than hashing a plain
 * concatenation. Same inputs, same rotation guarantee, but the salt is a real
 * key — no length-extension, and the `\n` separators mean two different field
 * splits can never produce the same message.
 */
export function visitorId(salt: string, fp: Fingerprint): string {
  return createHmac('sha256', salt)
    .update(fp.ip)
    .update('\n')
    .update(fp.userAgent)
    .update('\n')
    .update(fp.domain)
    .digest()
    .subarray(0, ID_BYTES)
    .toString('base64url');
}

/**
 * An opaque per-IP key for rate limiting.
 *
 * Domain-independent and tagged separately so it can never collide with a
 * visitor ID, but rotates with the same salt — a rate-limit table is not
 * allowed to outlive the salt that anonymized it either.
 */
export function rateLimitKey(salt: string, ip: string): string {
  return createHmac('sha256', salt)
    .update('ratelimit\n')
    .update(ip)
    .digest()
    .subarray(0, ID_BYTES)
    .toString('base64url');
}

interface Session {
  id: string;
  lastSeen: number;
}

/**
 * Assigns session IDs using a sliding 30-minute inactivity window.
 *
 * A fixed clock-aligned bucket would be simpler, but it splits a single visit
 * in half whenever someone browses across the boundary, which quietly inflates
 * session counts and wrecks bounce rate. This keeps the standard definition.
 *
 * State lives in memory only: visitor IDs (already anonymous and already
 * rotating daily) plus a timestamp. Nothing here is persisted, so a restart
 * costs at most one window of session continuity.
 */
export class SessionTracker {
  private readonly sessions = new Map<string, Session>();
  private lastSweep = 0;

  constructor(
    private readonly windowMs: number = SESSION_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The session for this visitor, starting a new one if they have been idle
   * longer than the window. Returns whether the visit is new, which is what
   * makes a pageview count as a session start.
   */
  assign(visitor: string): { sessionId: string; isNewSession: boolean } {
    const now = this.now();
    this.maybeSweep(now);

    const existing = this.sessions.get(visitor);
    if (existing && now - existing.lastSeen < this.windowMs) {
      existing.lastSeen = now;
      // Re-insert so Map iteration order stays least-recently-seen first,
      // which is what makes the overflow sweep evict the right entries.
      this.sessions.delete(visitor);
      this.sessions.set(visitor, existing);
      return { sessionId: existing.id, isNewSession: false };
    }

    const session: Session = {
      id: createHmac('sha256', visitor)
        .update(String(now))
        .digest()
        .subarray(0, ID_BYTES)
        .toString('base64url'),
      lastSeen: now,
    };
    this.sessions.set(visitor, session);
    return { sessionId: session.id, isNewSession: true };
  }

  /** Number of sessions currently held. Exposed for tests and diagnostics. */
  get size(): number {
    return this.sessions.size;
  }

  private maybeSweep(now: number): void {
    const due = now - this.lastSweep >= this.windowMs;
    if (!due && this.sessions.size < MAX_TRACKED_SESSIONS) return;

    this.lastSweep = now;
    for (const [visitor, session] of this.sessions) {
      if (now - session.lastSeen >= this.windowMs) this.sessions.delete(visitor);
      // Entries are ordered least-recently-seen first, so the first live one
      // means everything after it is live too.
      else break;
    }

    // Still oversized after expiring everything idle: drop the coldest entries.
    // Losing them only restarts a session early; unbounded growth is worse.
    if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const excess = this.sessions.size - Math.floor(MAX_TRACKED_SESSIONS * 0.9);
      let dropped = 0;
      for (const visitor of this.sessions.keys()) {
        if (dropped++ >= excess) break;
        this.sessions.delete(visitor);
      }
    }
  }
}

const globalRef = globalThis as typeof globalThis & {
  __implausibleSessions?: SessionTracker;
};

export function sessionTracker(): SessionTracker {
  globalRef.__implausibleSessions ??= new SessionTracker();
  return globalRef.__implausibleSessions;
}
