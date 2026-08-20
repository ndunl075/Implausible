/**
 * Event ingest.
 *
 * The shape of this function is dictated by one rule: nothing here is allowed
 * to sit in front of a visitor's page load. Validation is cheap and synchronous,
 * the response goes out at 202, and the write happens after — see queue.ts.
 *
 * Invariant 1 lives here too. `clientIp` returns a string that is passed to the
 * hashing functions and to nothing else. It is not attached to the event, not
 * returned in a response, and not included in any error.
 */
import { config, isAllowedDomain } from './config';
import { lookupCountry } from './geo';
import { ingestQueue } from './queue';
import { rateLimiter } from './ratelimit';
import { referrerSource } from './referrer';
import { saltStore } from './salt';
import { isBot, parseUserAgent } from './ua';
import { rateLimitKey, sessionTracker, visitorId } from './visitor';

/** Requests larger than this are refused unread. The payload is four fields. */
const MAX_BODY_BYTES = 2_048;

const MAX_PATHNAME = 512;
const MAX_REFERRER = 2_048;
const MAX_DOMAIN = 253;

/** Below this viewport width a "desktop" user agent is really a phone. */
const NARROW_VIEWPORT = 520;

export interface RawEvent {
  domain: string;
  pathname: string;
  referrer: string | null;
  screen_width: number | null;
}

type Outcome =
  | { status: 202; reason: 'accepted' | 'bot' }
  | { status: 400; reason: 'malformed' | 'invalid-domain' | 'invalid-path' }
  | { status: 403; reason: 'domain-not-allowed' }
  | { status: 413; reason: 'too-large' }
  | { status: 429; reason: 'rate-limited'; retryAfter: number };

/**
 * The visitor's address, from whichever proxy header is present.
 *
 * These headers are trivially spoofable when the app is exposed directly, so
 * Implausible expects to run behind a reverse proxy that sets them. A spoofed
 * value costs accuracy — it cannot leak anything, because the value is never
 * stored in any form.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-real-ip') ??
    headers.get('fly-client-ip') ??
    ''
  );
}

/** Strips query and fragment, normalises the trailing slash, enforces a cap. */
export function normalisePathname(value: string): string | null {
  let pathname = value.split('#')[0]?.split('?')[0] ?? '';
  if (!pathname.startsWith('/')) return null;
  if (pathname.length > MAX_PATHNAME) pathname = pathname.slice(0, MAX_PATHNAME);

  // "/pricing" and "/pricing/" are one page, and splitting them would split
  // every metric that groups by path.
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  return pathname;
}

function parseBody(text: string): RawEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const body = parsed as Record<string, unknown>;
  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  const pathname = typeof body.pathname === 'string' ? body.pathname : '';
  if (!domain || domain.length > MAX_DOMAIN || !pathname) return null;

  const referrer =
    typeof body.referrer === 'string' && body.referrer.length <= MAX_REFERRER
      ? body.referrer
      : null;

  const width = Number(body.screen_width);
  const screen_width =
    Number.isFinite(width) && width > 0 && width < 20_000 ? Math.trunc(width) : null;

  return { domain: domain.toLowerCase(), pathname, referrer, screen_width };
}

/**
 * A "desktop" user agent on a phone-width viewport is a phone in desktop mode.
 *
 * This is the only thing `screen_width` is used for. It is never stored — the
 * schema has no column for it, and a stored viewport width is one more bit that
 * narrows down who someone is.
 */
function refineDevice(
  device: 'desktop' | 'mobile' | 'tablet',
  screenWidth: number | null,
): 'desktop' | 'mobile' | 'tablet' {
  if (device === 'desktop' && screenWidth !== null && screenWidth < NARROW_VIEWPORT) {
    return 'mobile';
  }
  return device;
}

/**
 * Validates, enriches and queues one event.
 *
 * Returns an outcome rather than a Response so the route handlers stay thin and
 * the whole decision tree is testable without spinning up a server.
 */
export async function ingest(
  body: string,
  headers: Headers,
  now: number = Date.now(),
): Promise<Outcome> {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { status: 413, reason: 'too-large' };
  }

  const event = parseBody(body);
  if (!event) return { status: 400, reason: 'malformed' };

  const pathname = normalisePathname(event.pathname);
  if (pathname === null) return { status: 400, reason: 'invalid-path' };

  // Checked before any work is done on the request: an unconfigured domain is
  // someone else's traffic, and it should cost this server nothing.
  if (!isAllowedDomain(event.domain)) {
    return { status: 403, reason: 'domain-not-allowed' };
  }

  const userAgent = headers.get('user-agent') ?? '';
  const ip = clientIp(headers);
  const salt = await saltStore().current();

  const limit = rateLimiter(config.rateLimit).check(rateLimitKey(salt, ip));
  if (!limit.allowed) {
    return { status: 429, reason: 'rate-limited', retryAfter: limit.retryAfter };
  }

  // Bots are dropped after the rate-limit check but before any write, so a
  // crawler still counts against its own budget without reaching storage.
  if (isBot(userAgent)) return { status: 202, reason: 'bot' };

  const visitor = visitorId(salt, { ip, userAgent, domain: event.domain });
  const { sessionId } = sessionTracker().assign(visitor);
  const client = parseUserAgent(userAgent);

  ingestQueue().enqueue({
    timestamp: now,
    domain: event.domain,
    pathname,
    visitorId: visitor,
    sessionId,
    referrerSrc: referrerSource(event.referrer, event.domain),
    country: await lookupCountry(ip),
    device: refineDevice(client.device, event.screen_width),
    browser: client.browser,
    os: client.os,
  });

  return { status: 202, reason: 'accepted' };
}

/** Turns an outcome into the response the tracker sees. */
export function toResponse(outcome: Outcome): Response {
  const headers: Record<string, string> = {
    // The tracker runs on other origins; without this the fetch fallback errors.
    'access-control-allow-origin': '*',
    // Nothing here should ever be cached, by anyone.
    'cache-control': 'no-store',
  };
  if (outcome.status === 429) {
    headers['retry-after'] = String(outcome.retryAfter);
  }

  // The body is intentionally empty. The tracker ignores it, and a reason
  // string would only tell a prober how the allowlist is configured.
  return new Response(null, { status: outcome.status, headers });
}
