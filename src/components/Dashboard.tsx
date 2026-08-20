'use client';

import { useCallback, useEffect, useState } from 'react';
import { Breakdown, type Tab } from '@/components/Breakdown';
import { Chart, type ChartMetric } from '@/components/Chart';
import { Realtime } from '@/components/Realtime';
import { compact, delta, duration, percent } from '@/lib/format';
import type { Period, Stats } from '@/lib/stats';

const PERIOD_LABELS: Record<Period, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

interface Props {
  initial: Stats;
  domains: string[];
}

export function Dashboard({ initial, domains }: Props) {
  const [domain, setDomain] = useState(initial.domain);
  const [period, setPeriod] = useState<Period>(initial.period);
  const [metric, setMetric] = useState<ChartMetric>('visitors');
  const [stats, setStats] = useState<Stats>(initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (nextDomain: string, nextPeriod: Period) => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/stats?domain=${encodeURIComponent(nextDomain)}&period=${nextPeriod}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error(String(response.status));
      setStats((await response.json()) as Stats);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (domain === initial.domain && period === initial.period) return;
    void load(domain, period);
  }, [domain, period, initial.domain, initial.period, load]);

  const { totals, previous } = stats;
  const multiDay = period !== '24h';

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 pb-20 sm:px-7">
      {/* ------------------------------ header ------------------------------ */}
      <header className="border-rule flex flex-wrap items-center justify-between gap-4 border-b py-5">
        <div className="flex items-center gap-3">
          <Mark />
          <div>
            <h1 className="text-[15px] leading-none font-semibold tracking-[0.14em] uppercase">
              Implausible
            </h1>
            <p className="legend mt-1.5">privacy-first analytics</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {domains.length > 1 ? (
            <select
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="panel text-ink cursor-pointer px-3 py-2 text-[13px]"
              aria-label="Site"
            >
              {domains.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <span className="panel text-ink-2 px-3 py-2 font-mono text-[13px]">{domain}</span>
          )}

          <div className="panel flex gap-0.5 p-0.5" role="group" aria-label="Period">
            {(Object.keys(PERIOD_LABELS) as Period[]).map((option) => {
              const selected = option === period;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setPeriod(option)}
                  aria-pressed={selected}
                  className="legend rounded-[3px] px-3 py-[9px] transition-colors"
                  style={{
                    color: selected ? 'var(--paper)' : 'var(--ink-3)',
                    background: selected ? 'var(--accent)' : 'transparent',
                  }}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* ------------------------------- live ------------------------------- */}
      <div className="border-rule flex flex-wrap items-end justify-between gap-6 border-b py-7">
        <Realtime domain={domain} initial={stats.realtime} />
        <p className="legend text-right leading-[1.7]">
          {PERIOD_LABELS[period]} &middot; {stats.interval} buckets
          <br />
          <span style={{ color: 'var(--ink-3)' }}>
            {new Date(stats.from).toUTCString().slice(5, 16)} —{' '}
            {new Date(stats.to).toUTCString().slice(5, 16)} UTC
          </span>
        </p>
      </div>

      {failed ? (
        <p
          className="mt-5 rounded-sm px-4 py-3 text-sm"
          style={{ background: 'var(--accent-soft)', color: 'var(--ink)' }}
          role="status"
        >
          Could not reach the stats endpoint. Showing the last figures that loaded.
        </p>
      ) : null}

      {/* ------------------------------ totals ------------------------------ */}
      <div
        className="grid grid-cols-2 gap-px lg:grid-cols-4"
        style={{ background: 'var(--rule)', opacity: loading ? 0.55 : 1, transition: 'opacity .18s' }}
      >
        <Stat
          i={0}
          label="Visitors"
          value={compact(totals.visitors)}
          exact={totals.visitors}
          previous={previous.visitors}
          note={
            multiDay
              ? 'Sum of daily uniques. IDs rotate every 24h, so one person across three days counts three times — by design.'
              : undefined
          }
        />
        <Stat
          i={1}
          label="Pageviews"
          value={compact(totals.pageviews)}
          exact={totals.pageviews}
          previous={previous.pageviews}
        />
        <Stat
          i={2}
          label="Bounce rate"
          value={percent(totals.bounceRate)}
          previous={previous.bounceRate}
          current={totals.bounceRate}
          kind="rate"
          invert
          note="Share of visits that were a single pageview."
        />
        <Stat
          i={3}
          label="Visit duration"
          value={duration(totals.avgSessionSeconds)}
          previous={previous.avgSessionSeconds}
          current={totals.avgSessionSeconds}
          kind="rate"
          note="First to last pageview, averaged across visits."
        />
      </div>

      {/* ------------------------------- chart ------------------------------ */}
      <section className="panel rise mt-px border-t-0" style={{ animationDelay: '120ms' }}>
        <header className="border-rule flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex gap-0.5">
            {(['visitors', 'pageviews'] as ChartMetric[]).map((option) => {
              const selected = option === metric;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMetric(option)}
                  aria-pressed={selected}
                  className="legend rounded-sm px-2.5 py-1.5 transition-colors"
                  style={{
                    color: selected ? 'var(--ink)' : 'var(--ink-3)',
                    background: selected ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  {option}
                </button>
              );
            })}
          </div>
          <span className="legend hidden sm:block">times in utc</span>
        </header>

        <div className="px-1 pt-1 pb-2">
          <Chart points={stats.timeseries} interval={stats.interval} metric={metric} />
        </div>
      </section>

      {/* ---------------------------- breakdowns ---------------------------- */}
      <div className="mt-5 grid items-stretch gap-5 lg:grid-cols-3">
        <div className="rise h-full" style={{ animationDelay: '180ms' }}>
          <Breakdown
            tabs={[{ key: 'pages', label: 'Top pages', rows: stats.breakdowns.pages }]}
          />
        </div>
        <div className="rise h-full" style={{ animationDelay: '240ms' }}>
          <Breakdown
            tabs={[
              { key: 'sources', label: 'Sources', rows: stats.breakdowns.sources },
              {
                key: 'countries',
                label: 'Countries',
                rows: stats.breakdowns.countries,
                kind: 'country',
              },
            ]}
            emptyHint="No country data. Point IMPLAUSIBLE_GEOIP_PATH at a local GeoLite2 file to enable it."
          />
        </div>
        <div className="rise h-full" style={{ animationDelay: '300ms' }}>
          <Breakdown tabs={deviceTabs(stats)} />
        </div>
      </div>

      {/* ------------------------------ footer ------------------------------ */}
      <footer className="border-rule text-ink-3 mt-10 border-t pt-5 text-[12px] leading-relaxed">
        <p className="max-w-2xl">
          Every visitor above is a hash of a salt that is thrown away every 24 hours. There is
          no cookie, no stored address, and nothing in this database that could tell you whether
          any of these people had been here before.
          {stats.interval === 'day'
            ? ' Each bucket on the chart is a separate day, and therefore a separate salt.'
            : ' The dashed marks on the chart are the moments that became true.'}
        </p>
      </footer>
    </div>
  );
}

function deviceTabs(stats: Stats): Tab[] {
  return [
    { key: 'device', label: 'Device', rows: stats.breakdowns.devices },
    { key: 'browser', label: 'Browser', rows: stats.breakdowns.browsers },
    { key: 'os', label: 'OS', rows: stats.breakdowns.operatingSystems },
  ];
}

interface StatProps {
  i: number;
  label: string;
  value: string;
  /** Numeric current/previous pair used for the trend. */
  exact?: number;
  current?: number;
  previous: number;
  /** For metrics where a rise is bad news, like bounce rate. */
  invert?: boolean;
  /** Rates and averages cannot be "new"; see delta(). */
  kind?: 'count' | 'rate';
  note?: string;
}

function Stat({ i, label, value, exact, current, previous, invert, kind, note }: StatProps) {
  const now = current ?? exact ?? 0;
  const change = delta(now, previous, kind);
  const good =
    change.direction === 'flat'
      ? null
      : invert
        ? change.direction === 'down'
        : change.direction === 'up';

  return (
    <div
      className="rise bg-paper-2 px-4 py-4"
      style={{ animationDelay: `${i * 55}ms` }}
      title={note}
    >
      <div className="flex items-center gap-1.5">
        <span className="legend">{label}</span>
        {note ? (
          <span
            aria-hidden
            className="text-[9px] leading-none"
            style={{ color: 'var(--ink-3)', opacity: 0.7 }}
          >
            ⓘ
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-baseline gap-2.5">
        <span className="tnum text-2xl leading-none font-semibold tracking-tight">{value}</span>
        <span
          className="tnum text-[11px] font-medium"
          style={{
            color:
              good === null ? 'var(--ink-3)' : good ? 'var(--live)' : 'var(--accent)',
          }}
          title={`Previous period: ${Math.round(previous).toLocaleString()}`}
        >
          {change.direction === 'up' ? '↑' : change.direction === 'down' ? '↓' : ''}
          {change.label}
        </span>
      </div>
    </div>
  );
}

/** A plotted trace, drawn small. Doubles as the favicon-scale mark. */
function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden className="shrink-0">
      <rect x="0.5" y="0.5" width="25" height="25" rx="3" fill="none" stroke="var(--rule)" />
      <path
        d="M4 18 L8 12 L11 15 L14 7 L18 13 L22 10"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="13" y1="2" x2="13" y2="24" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="1 3" />
    </svg>
  );
}
