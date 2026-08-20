/**
 * Per-IP rate limiting.
 *
 * The key is a hash, never an address (see `rateLimitKey`), and it rotates with
 * the daily salt — a rate-limit table is not allowed to outlive the salt that
 * anonymised it either. That means a limiter entry cannot be used to recognise
 * anyone tomorrow, which is the same guarantee the event rows carry.
 *
 * A fixed window rather than a token bucket: the goal is to stop one source
 * flooding the store, not to shape traffic precisely, and a window costs one
 * integer per active client.
 */

const WINDOW_MS = 60_000;

/** Beyond this many tracked keys the table is swept early. */
const MAX_KEYS = 100_000;

interface Window {
  count: number;
  /** Epoch ms when this window opened. */
  start: number;
}

export interface Verdict {
  allowed: boolean;
  /** Requests still permitted in the current window. */
  remaining: number;
  /** Seconds until the window resets. Only meaningful when blocked. */
  retryAfter: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a request against a key and reports whether it may proceed. */
  check(key: string): Verdict {
    const now = this.now();
    this.maybeSweep(now);

    const existing = this.windows.get(key);
    if (!existing || now - existing.start >= this.windowMs) {
      this.windows.set(key, { count: 1, start: now });
      return { allowed: true, remaining: this.limit - 1, retryAfter: 0 };
    }

    existing.count++;
    const remaining = this.limit - existing.count;
    if (remaining >= 0) {
      return { allowed: true, remaining, retryAfter: 0 };
    }

    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((existing.start + this.windowMs - now) / 1000),
    };
  }

  /** Tracked keys. Exposed for tests and diagnostics. */
  get size(): number {
    return this.windows.size;
  }

  private maybeSweep(now: number): void {
    const due = now - this.lastSweep >= this.windowMs;
    if (!due && this.windows.size < MAX_KEYS) return;

    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }

    // Still oversized with every window live: this is a distributed flood, and
    // holding the table is worse than letting the next requests through.
    if (this.windows.size >= MAX_KEYS) this.windows.clear();
  }
}

const globalRef = globalThis as typeof globalThis & {
  __implausibleLimiter?: RateLimiter;
};

export function rateLimiter(limit: number): RateLimiter {
  globalRef.__implausibleLimiter ??= new RateLimiter(limit);
  return globalRef.__implausibleLimiter;
}
