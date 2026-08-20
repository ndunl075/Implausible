/**
 * Aggregate queries for the dashboard.
 *
 * Everything here returns counts and averages. There is no code path that
 * returns a row, a visitor ID, or a session ID — the API surface simply has no
 * shape that could carry one.
 *
 * A note on what "visitors" means over more than a day. Visitor IDs are derived
 * from a salt that rotates every 24 hours, so the same person on Monday and
 * Tuesday is two different IDs and counts twice. A 7-day visitor count is
 * therefore the sum of daily uniques, not the number of distinct people. That
 * is not an approximation to be fixed later; it is the direct consequence of
 * never storing anything that could tell those two rows apart. The dashboard
 * says so out loud rather than quietly implying otherwise.
 */
import { query } from './db';
import { EVENT_COLUMNS } from './schema';

export type Period = '24h' | '7d' | '30d';

export const PERIODS: readonly Period[] = ['24h', '7d', '30d'];

/**
 * Every value the `metric` parameter accepts.
 *
 * `all` returns the whole payload the dashboard renders. Naming a single
 * metric runs only the query behind it, which is the point: the realtime
 * counter polls every five seconds, and making it pay for ten aggregations to
 * update one number would be indefensible.
 */
export const METRICS = [
  'all',
  'realtime',
  'visitors',
  'pageviews',
  'sessions',
  'bounce_rate',
  'avg_duration',
  'views_per_visit',
  'timeseries',
  'pages',
  'sources',
  'countries',
  'devices',
  'browsers',
  'os',
] as const;

export type Metric = (typeof METRICS)[number];

/** `true` when the value names a supported metric. */
export function isMetric(value: string | null): value is Metric {
  return value !== null && (METRICS as readonly string[]).includes(value);
}

/** Visitors counted as "right now". */
const REALTIME_WINDOW_MS = 5 * 60 * 1000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Shape {
  /** Total span of the window. */
  spanMs: number;
  /** Width of one chart bucket. */
  bucketMs: number;
  label: 'hour' | '6 hours' | 'day';
}

const SHAPES: Record<Period, Shape> = {
  '24h': { spanMs: DAY, bucketMs: HOUR, label: 'hour' },
  // 6-hour buckets rather than daily: seven points is too sparse to read as a
  // trend, and 168 hourly points is noise.
  '7d': { spanMs: 7 * DAY, bucketMs: 6 * HOUR, label: '6 hours' },
  '30d': { spanMs: 30 * DAY, bucketMs: DAY, label: 'day' },
};

export interface Totals {
  visitors: number;
  pageviews: number;
  sessions: number;
  /** Share of sessions that were a single pageview, 0–1. */
  bounceRate: number;
  avgSessionSeconds: number;
  viewsPerVisit: number;
}

export interface TimeseriesPoint {
  /** Bucket start, ISO 8601 UTC. */
  t: string;
  visitors: number;
  pageviews: number;
}

export interface BreakdownRow {
  name: string;
  visitors: number;
  pageviews: number;
}

export interface Breakdowns {
  pages: BreakdownRow[];
  sources: BreakdownRow[];
  countries: BreakdownRow[];
  devices: BreakdownRow[];
  browsers: BreakdownRow[];
  operatingSystems: BreakdownRow[];
}

export interface Stats {
  domain: string;
  period: Period;
  from: string;
  to: string;
  interval: Shape['label'];
  /** Distinct visitors in the last five minutes. */
  realtime: number;
  totals: Totals;
  /** The same totals for the window immediately before this one. */
  previous: Totals;
  timeseries: TimeseriesPoint[];
  breakdowns: Breakdowns;
}

const EMPTY_TOTALS: Totals = {
  visitors: 0,
  pageviews: 0,
  sessions: 0,
  bounceRate: 0,
  avgSessionSeconds: 0,
  viewsPerVisit: 0,
};

/** `true` when the value is one of the three supported periods. */
export function isPeriod(value: string | null): value is Period {
  return value !== null && (PERIODS as readonly string[]).includes(value);
}

/** DuckDB timestamp literal, UTC, no zone suffix. */
function ts(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The first bucket boundary strictly after `epochMs`.
 *
 * Strictly after, not `Math.ceil`. When the clock lands exactly on a boundary —
 * which for daily buckets is every midnight — ceil returns that same instant,
 * the window becomes `[start, now)`, and an event arriving right now falls
 * outside it. Every metric would then read zero for whatever traffic arrived on
 * the tick. Advancing to the next boundary means the final bucket is always the
 * one in progress.
 */
function nextBoundary(epochMs: number, stepMs: number): number {
  return (Math.floor(epochMs / stepMs) + 1) * stepMs;
}

/** The aligned window a period covers, plus the window before it. */
export function windowFor(period: Period, now: number = Date.now()) {
  const { spanMs, bucketMs, label } = SHAPES[period];
  const end = nextBoundary(now, bucketMs);
  const start = end - spanMs;
  return {
    start: new Date(start),
    end: new Date(end),
    previousStart: new Date(start - spanMs),
    previousEnd: new Date(start),
    bucketSeconds: bucketMs / 1000,
    interval: label,
  };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function totalsFor(
  domain: string,
  from: Date,
  to: Date,
): Promise<Totals> {
  const [row] = await query(
    `WITH windowed AS (
       SELECT * FROM events
       WHERE domain = $1 AND timestamp >= $2::TIMESTAMP AND timestamp < $3::TIMESTAMP
     ),
     per_session AS (
       SELECT session_id,
              count(*) AS views,
              epoch(max(timestamp) - min(timestamp)) AS seconds
       FROM windowed
       GROUP BY session_id
     )
     SELECT
       (SELECT count(DISTINCT visitor_id) FROM windowed)::INTEGER   AS visitors,
       (SELECT count(*) FROM windowed)::INTEGER                     AS pageviews,
       (SELECT count(*) FROM per_session)::INTEGER                  AS sessions,
       (SELECT coalesce(sum(CASE WHEN views = 1 THEN 1 ELSE 0 END), 0)
          FROM per_session)::INTEGER                                AS bounces,
       (SELECT coalesce(avg(seconds), 0) FROM per_session)::DOUBLE  AS avg_seconds`,
    [domain, ts(from), ts(to)],
  );

  if (!row) return { ...EMPTY_TOTALS };

  const visitors = num(row.visitors);
  const pageviews = num(row.pageviews);
  const sessions = num(row.sessions);
  const bounces = num(row.bounces);

  return {
    visitors,
    pageviews,
    sessions,
    bounceRate: sessions > 0 ? bounces / sessions : 0,
    avgSessionSeconds: Math.round(num(row.avg_seconds)),
    viewsPerVisit: sessions > 0 ? pageviews / sessions : 0,
  };
}

async function timeseriesFor(
  domain: string,
  from: Date,
  to: Date,
  bucketSeconds: number,
): Promise<TimeseriesPoint[]> {
  // The bucket list is generated and left-joined so empty periods come back as
  // zeros. Without it a quiet hour would simply be missing, and the chart would
  // draw a straight line across the gap — which reads as traffic that never
  // happened.
  const rows = await query(
    `WITH buckets AS (
       SELECT unnest(range($2::TIMESTAMP, $3::TIMESTAMP, to_seconds($4::BIGINT))) AS bucket
     ),
     agg AS (
       SELECT $2::TIMESTAMP
                + to_seconds(floor(epoch(timestamp - $2::TIMESTAMP) / $4) * $4) AS bucket,
              count(DISTINCT visitor_id)::INTEGER AS visitors,
              count(*)::INTEGER                   AS pageviews
       FROM events
       WHERE domain = $1 AND timestamp >= $2::TIMESTAMP AND timestamp < $3::TIMESTAMP
       GROUP BY 1
     )
     SELECT strftime(b.bucket, '%Y-%m-%dT%H:%M:%SZ') AS t,
            coalesce(a.visitors, 0)::INTEGER        AS visitors,
            coalesce(a.pageviews, 0)::INTEGER       AS pageviews
     FROM buckets b
     LEFT JOIN agg a USING (bucket)
     ORDER BY b.bucket`,
    [domain, ts(from), ts(to), bucketSeconds],
  );

  return rows.map((row) => ({
    t: String(row.t),
    visitors: num(row.visitors),
    pageviews: num(row.pageviews),
  }));
}

/** Columns a breakdown is allowed to group by. */
type BreakdownColumn = Extract<
  (typeof EVENT_COLUMNS)[number],
  'pathname' | 'referrer_src' | 'country' | 'device' | 'browser' | 'os'
>;

/**
 * One breakdown table.
 *
 * The column name is interpolated rather than bound, because SQL parameters
 * cannot stand in for identifiers. The type restricts it to a literal union at
 * compile time, and the runtime check below re-verifies it against the schema's
 * own column list — belt and braces, because this is the one place in the
 * codebase where a string reaches a query uninterpolated, and a future caller
 * passing something request-derived should hit a wall rather than a query.
 */
async function breakdown(
  domain: string,
  from: Date,
  to: Date,
  column: BreakdownColumn,
  limit: number,
): Promise<BreakdownRow[]> {
  if (!(EVENT_COLUMNS as readonly string[]).includes(column)) {
    throw new Error(`refusing to group by an unknown column: ${column}`);
  }
  const rowLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);

  const rows = await query(
    `SELECT ${column} AS name,
            count(DISTINCT visitor_id)::INTEGER AS visitors,
            count(*)::INTEGER                   AS pageviews
     FROM events
     WHERE domain = $1
       AND timestamp >= $2::TIMESTAMP
       AND timestamp < $3::TIMESTAMP
       AND ${column} IS NOT NULL
     GROUP BY 1
     ORDER BY visitors DESC, pageviews DESC, name ASC
     LIMIT ${rowLimit}`,
    [domain, ts(from), ts(to)],
  );

  return rows.map((row) => ({
    name: String(row.name),
    visitors: num(row.visitors),
    pageviews: num(row.pageviews),
  }));
}

/** Distinct visitors seen in the last five minutes. */
export async function realtimeVisitors(
  domain: string,
  now: number = Date.now(),
): Promise<number> {
  const [row] = await query(
    `SELECT count(DISTINCT visitor_id)::INTEGER AS visitors
     FROM events
     WHERE domain = $1 AND timestamp >= $2::TIMESTAMP`,
    [domain, ts(new Date(now - REALTIME_WINDOW_MS))],
  );
  return num(row?.visitors);
}

/** Everything the dashboard renders, for one domain and period. */
/**
 * The breakdown tables, and how many rows each is worth showing.
 *
 * Shared between the full payload and the single-metric path so the two can
 * never disagree about what "sources" means or how deep it goes.
 */
const BREAKDOWNS = {
  pages: { column: 'pathname', limit: 10 },
  sources: { column: 'referrer_src', limit: 10 },
  countries: { column: 'country', limit: 10 },
  devices: { column: 'device', limit: 5 },
  browsers: { column: 'browser', limit: 8 },
  os: { column: 'os', limit: 8 },
} as const satisfies Record<string, { column: BreakdownColumn; limit: number }>;

type BreakdownKey = keyof typeof BREAKDOWNS;

/** Totals that can be asked for on their own, and where they live. */
const SCALARS = {
  visitors: 'visitors',
  pageviews: 'pageviews',
  sessions: 'sessions',
  bounce_rate: 'bounceRate',
  avg_duration: 'avgSessionSeconds',
  views_per_visit: 'viewsPerVisit',
} as const satisfies Record<string, keyof Totals>;

type ScalarKey = keyof typeof SCALARS;

export type MetricResult =
  | { kind: 'stats'; stats: Stats }
  | { kind: 'realtime'; realtime: number }
  | { kind: 'scalar'; value: number; previous: number }
  | { kind: 'timeseries'; points: TimeseriesPoint[] }
  | { kind: 'breakdown'; rows: BreakdownRow[] };

/**
 * Resolves one named metric, running only the query it needs.
 *
 * Returns a tagged result rather than a bare value so the route can shape the
 * response without re-deriving which kind of metric it asked for.
 */
export async function getMetric(
  domain: string,
  metric: Metric,
  period: Period,
  now: number = Date.now(),
): Promise<MetricResult> {
  if (metric === 'all') {
    return { kind: 'stats', stats: await getStats(domain, period, now) };
  }
  if (metric === 'realtime') {
    return { kind: 'realtime', realtime: await realtimeVisitors(domain, now) };
  }

  const w = windowFor(period, now);

  if (metric === 'timeseries') {
    return {
      kind: 'timeseries',
      points: await timeseriesFor(domain, w.start, w.end, w.bucketSeconds),
    };
  }

  if (metric in BREAKDOWNS) {
    const { column, limit } = BREAKDOWNS[metric as BreakdownKey];
    return {
      kind: 'breakdown',
      rows: await breakdown(domain, w.start, w.end, column, limit),
    };
  }

  const field = SCALARS[metric as ScalarKey];
  const [current, previous] = await Promise.all([
    totalsFor(domain, w.start, w.end),
    totalsFor(domain, w.previousStart, w.previousEnd),
  ]);
  return { kind: 'scalar', value: current[field], previous: previous[field] };
}

export async function getStats(
  domain: string,
  period: Period,
  now: number = Date.now(),
): Promise<Stats> {
  const w = windowFor(period, now);

  /** Listed one by one rather than mapped, so the tuple below stays typed. */
  const table = (key: BreakdownKey) =>
    breakdown(domain, w.start, w.end, BREAKDOWNS[key].column, BREAKDOWNS[key].limit);

  const [
    realtime,
    totals,
    previous,
    timeseries,
    pages,
    sources,
    countries,
    devices,
    browsers,
    operatingSystems,
  ] = await Promise.all([
    realtimeVisitors(domain, now),
    totalsFor(domain, w.start, w.end),
    totalsFor(domain, w.previousStart, w.previousEnd),
    timeseriesFor(domain, w.start, w.end, w.bucketSeconds),
    table('pages'),
    table('sources'),
    table('countries'),
    table('devices'),
    table('browsers'),
    table('os'),
  ]);

  return {
    domain,
    period,
    from: w.start.toISOString(),
    to: w.end.toISOString(),
    interval: w.interval,
    realtime,
    totals,
    previous,
    timeseries,
    breakdowns: { pages, sources, countries, devices, browsers, operatingSystems },
  };
}
