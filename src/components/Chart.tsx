'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TimeseriesPoint } from '@/lib/stats';

/**
 * The traffic plot.
 *
 * Hand-drawn SVG rather than a charting library. Three reasons: the salt
 * rotation markers below are not a feature any library has, the hairline
 * instrument look means fighting a library's defaults on every element, and a
 * project whose headline claim is a 1 KB tracker should not ship 100 KB of
 * chart code to draw one area. It is about 200 lines and has no dependencies.
 */

export type ChartMetric = 'visitors' | 'pageviews';

interface Props {
  points: TimeseriesPoint[];
  interval: string;
  metric: ChartMetric;
}

const PAD = { top: 18, right: 14, bottom: 30, left: 46 };
const HEIGHT = 300;

/** Rounds a maximum up to something a human would choose for an axis. */
function niceMax(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Axis labels are UTC, because the buckets and the salt rotation are UTC. */
function axisLabel(iso: string, interval: string): string {
  const d = new Date(iso);
  if (interval === 'day') return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (interval === 'hour') return `${pad2(d.getUTCHours())}:00`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:00`;
}

function fullLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(
    d.getUTCMinutes(),
  )} UTC`;
}

/** Measures the container, so strokes stay hairline instead of being scaled. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(880);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export function Chart({ points, interval, metric }: Props) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);

  const plot = useMemo(() => {
    const innerW = Math.max(1, width - PAD.left - PAD.right);
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const values = points.map((p) => p[metric]);
    const max = niceMax(Math.max(1, ...values));

    const x = (i: number) =>
      PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

    const line = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(p[metric]).toFixed(2)}`)
      .join(' ');

    const area =
      points.length > 0
        ? `${line} L${x(points.length - 1).toFixed(2)},${PAD.top + innerH} L${x(0).toFixed(
            2,
          )},${PAD.top + innerH} Z`
        : '';

    // A marker wherever the UTC date changes: the instant every visitor ID in
    // the store stopped being connectable to the ones after it. Suppressed on
    // the 30-day view, where every bucket is a midnight and thirty identical
    // hairlines would be noise rather than information.
    const rotations =
      interval === 'day'
        ? []
        : points.reduce<number[]>((acc, point, i) => {
            if (i === 0) return acc;
            const previous = points[i - 1];
            if (!previous) return acc;
            if (new Date(point.t).getUTCDate() !== new Date(previous.t).getUTCDate()) {
              acc.push(i);
            }
            return acc;
          }, []);

    // Axis labels need room: the 7-day view writes "14 Aug 00:00", which is
    // wide enough to collide at the density a bare hour label would allow.
    const labelWidth = interval === 'hour' || interval === 'day' ? 64 : 116;
    const every = Math.max(
      1,
      Math.ceil(points.length / Math.max(2, Math.floor(innerW / labelWidth))),
    );

    return { innerW, innerH, max, x, y, line, area, rotations, every };
  }, [points, width, metric, interval]);

  const onMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (points.length === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const relative = event.clientX - rect.left - PAD.left;
      const ratio = relative / Math.max(1, plot.innerW);
      const index = Math.round(ratio * (points.length - 1));
      setHover(Math.min(points.length - 1, Math.max(0, index)));
    },
    [points.length, plot.innerW],
  );

  const active = hover === null ? null : points[hover];
  const totalLength = Math.max(plot.innerW, 1) * 1.6;

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="block touch-none select-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${metric} per ${interval} over the selected period`}
      >
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal rules with their values, the way a plotter grid reads. */}
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const value = plot.max * fraction;
          const yPos = plot.y(value);
          return (
            <g key={fraction}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={yPos}
                y2={yPos}
                stroke="var(--rule)"
                strokeWidth={1}
                strokeDasharray={fraction === 0 ? undefined : '2 4'}
                opacity={fraction === 0 ? 1 : 0.7}
              />
              <text
                x={PAD.left - 10}
                y={yPos + 3}
                textAnchor="end"
                className="tnum"
                fontSize={10}
                fontFamily="var(--font-mono)"
                fill="var(--ink-3)"
              >
                {Math.round(value).toLocaleString()}
              </text>
            </g>
          );
        })}

        {/* Salt rotations: the product thesis, drawn. */}
        {plot.rotations.map((index) => (
          <g key={`rot-${index}`}>
            <line
              x1={plot.x(index)}
              x2={plot.x(index)}
              y1={PAD.top - 4}
              y2={PAD.top + plot.innerH}
              stroke="var(--ink-3)"
              strokeWidth={1}
              strokeDasharray="1 5"
              opacity={0.85}
            />
            {/* The hairline still marks the rotation; only the caption is
                dropped when there is no room to set it without clipping. */}
            {plot.x(index) + 84 < width - PAD.right ? (
              <text
                x={plot.x(index) + 5}
                y={PAD.top + 6}
                fontSize={8.5}
                fontFamily="var(--font-mono)"
                letterSpacing="0.14em"
                fill="var(--ink-3)"
              >
                SALT ROTATED
              </text>
            ) : null}
          </g>
        ))}

        <path d={plot.area} fill="url(#fill)" />
        <path
          d={plot.line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={
            {
              '--len': totalLength,
              strokeDasharray: totalLength,
              animation: 'sweep 0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards',
            } as React.CSSProperties
          }
        />

        {/* X axis */}
        {points.map((point, i) => {
          if (i % plot.every !== 0) return null;
          const at = plot.x(i);
          // Anchor the first and last labels inward, so an axis label never
          // runs past the edge of the plot and gets cut in half.
          const nearEnd = at > width - PAD.right - 46;
          return (
            <text
              key={point.t}
              x={at}
              y={HEIGHT - 10}
              textAnchor={i === 0 ? 'start' : nearEnd ? 'end' : 'middle'}
              fontSize={10}
              fontFamily="var(--font-mono)"
              fill="var(--ink-3)"
            >
              {axisLabel(point.t, interval)}
            </text>
          );
        })}

        {/* Crosshair */}
        {hover !== null && active ? (
          <g pointerEvents="none">
            <line
              x1={plot.x(hover)}
              x2={plot.x(hover)}
              y1={PAD.top}
              y2={PAD.top + plot.innerH}
              stroke="var(--accent)"
              strokeWidth={1}
              opacity={0.45}
            />
            <circle
              cx={plot.x(hover)}
              cy={plot.y(active[metric])}
              r={4}
              fill="var(--paper-2)"
              stroke="var(--accent)"
              strokeWidth={2}
            />
          </g>
        ) : null}
      </svg>

      {hover !== null && active ? (
        <div
          className="panel pointer-events-none absolute top-2 z-10 px-3 py-2"
          style={{
            left: Math.min(Math.max(plot.x(hover) - 76, 4), Math.max(4, width - 160)),
          }}
        >
          <div className="legend">{fullLabel(active.t)}</div>
          <div className="tnum mt-1.5 flex gap-4 text-[13px]">
            <span>
              <span className="text-ink-3">visitors </span>
              <span className="font-medium">{active.visitors.toLocaleString()}</span>
            </span>
            <span>
              <span className="text-ink-3">views </span>
              <span className="font-medium">{active.pageviews.toLocaleString()}</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
