/**
 * GET /api/stats?domain=…&period=24h|7d|30d&metric=all|realtime
 *
 * Aggregates only. Nothing this route can return carries a visitor ID, a
 * session ID, or a single row — see stats.ts.
 *
 * `metric=realtime` exists because the dashboard polls it every five seconds.
 * Running the full set of queries at that rate to update one number would be
 * wasteful, so the poll gets its own cheap path.
 */
import { isAllowedDomain } from '@/lib/config';
import { getStats, isPeriod, realtimeVisitors } from '@/lib/stats';

// DuckDB is a native module, so this cannot run on the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const domain = (params.get('domain') ?? '').trim().toLowerCase();
  if (!domain) return json({ error: 'domain is required' }, 400);

  // The same allowlist ingest uses. Without it this route would happily report
  // on any domain string a prober cared to try.
  if (!isAllowedDomain(domain)) return json({ error: 'unknown domain' }, 404);

  const metric = params.get('metric') ?? 'all';
  if (metric === 'realtime') {
    return json({ domain, realtime: await realtimeVisitors(domain) });
  }
  if (metric !== 'all') {
    return json({ error: 'metric must be all or realtime' }, 400);
  }

  const period = params.get('period') ?? '24h';
  if (!isPeriod(period)) {
    return json({ error: 'period must be 24h, 7d or 30d' }, 400);
  }

  return json(await getStats(domain, period));
}
