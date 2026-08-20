/**
 * GET /api/stats?domain=…&period=24h|7d|30d&metric=…
 *
 * Aggregates only. Nothing this route can return carries a visitor ID, a
 * session ID, or a single row — see stats.ts.
 *
 * `metric` selects what comes back. Omitted, it is `all`: the whole payload the
 * dashboard renders. Naming one metric runs only the query behind it, which is
 * what makes the five-second realtime poll cheap enough to be honest about.
 *
 *   metric=all              everything below, in one response
 *   metric=realtime         visitors in the last five minutes
 *   metric=visitors         |
 *   metric=pageviews        |
 *   metric=sessions         |  a single total, with the previous period
 *   metric=bounce_rate      |  alongside it for comparison
 *   metric=avg_duration     |
 *   metric=views_per_visit  |
 *   metric=timeseries       the chart series for the period
 *   metric=pages            |
 *   metric=sources          |
 *   metric=countries        |  a ranked table
 *   metric=devices          |
 *   metric=browsers         |
 *   metric=os               |
 */
import { isAllowedDomain } from '@/lib/config';
import { METRICS, getMetric, isMetric, isPeriod } from '@/lib/stats';

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
  if (!isMetric(metric)) {
    return json({ error: 'unknown metric', supported: METRICS }, 400);
  }

  const period = params.get('period') ?? '24h';
  if (!isPeriod(period)) {
    return json({ error: 'period must be 24h, 7d or 30d' }, 400);
  }

  const result = await getMetric(domain, metric, period);

  // The full payload keeps its own shape, so an existing client that never
  // passed `metric` sees exactly what it saw before.
  if (result.kind === 'stats') return json(result.stats);

  // Realtime has no period: it is always the last five minutes, and saying
  // otherwise in the response would imply a window that was never applied.
  if (result.kind === 'realtime') {
    return json({ domain, metric, realtime: result.realtime });
  }

  const envelope = { domain, metric, period };

  switch (result.kind) {
    case 'scalar':
      return json({ ...envelope, value: result.value, previous: result.previous });
    case 'timeseries':
      return json({ ...envelope, points: result.points });
    case 'breakdown':
      return json({ ...envelope, rows: result.rows });
  }
}
