/**
 * GET /api/health
 *
 * For load balancers and deploy checks. Reports whether the store is
 * reachable, whether geo attribution is active, and how the ingest queue is
 * doing.
 *
 * Deliberately absent: the salt itself, anything derived from it, and any
 * count that could be correlated with a single visitor. Time until the next
 * rotation is included on purpose — an operator should be able to confirm the
 * salt really is rotating without being asked to take it on faith.
 */
import { config } from '@/lib/config';
import { query } from '@/lib/db';
import { geoStatus, initGeo } from '@/lib/geo';
import { ingestQueue } from '@/lib/queue';
import { saltStore } from '@/lib/salt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  // The reader opens lazily on the first lookup, so on a freshly started
  // process the status would otherwise report "unknown" rather than the real
  // reason. A health check that says nothing is worse than no health check.
  await initGeo();
  const geo = geoStatus();
  let storage: 'ok' | 'unavailable' = 'ok';
  let events = 0;

  try {
    const [row] = await query(`SELECT count(*)::INTEGER AS n FROM events`);
    events = Number(row?.n ?? 0);
  } catch {
    storage = 'unavailable';
  }

  const body = {
    status: storage === 'ok' ? 'ok' : 'degraded',
    storage,
    events,
    domains: config.allowedDomains.length,
    queue: ingestQueue().stats(),
    geoip: { enabled: geo.enabled, reason: geo.reason },
    salt: { rotatesInSeconds: Math.round((await saltStore().msUntilRotation()) / 1000) },
  };

  return new Response(JSON.stringify(body), {
    status: storage === 'ok' ? 200 : 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
