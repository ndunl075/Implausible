'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The live visitor readout.
 *
 * This is the one number on the page that has to feel alive, so it gets more
 * attention than its information content strictly deserves: a breathing status
 * lamp, and a brief wash of accent behind the figure whenever it changes. The
 * flash matters because the digits often move by one, which is easy to miss if
 * you happened to look away.
 */

interface Props {
  domain: string;
  initial: number;
  /** Poll interval in milliseconds. */
  every?: number;
}

export function Realtime({ domain, initial, every = 5_000 }: Props) {
  const [count, setCount] = useState(initial);
  const [ticked, setTicked] = useState(false);
  const [stale, setStale] = useState(false);
  const previous = useRef(initial);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function poll() {
      try {
        const response = await fetch(
          `/api/stats?domain=${encodeURIComponent(domain)}&metric=realtime`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (!response.ok) throw new Error(String(response.status));

        const { realtime } = (await response.json()) as { realtime: number };
        if (cancelled) return;

        setStale(false);
        setCount(realtime);
        if (realtime !== previous.current) {
          previous.current = realtime;
          setTicked(true);
          // Long enough for the wash to play out, short enough that two ticks
          // in quick succession both register.
          setTimeout(() => !cancelled && setTicked(false), 1_100);
        }
      } catch {
        // A missed poll is not worth surfacing as an error; the lamp goes
        // amber and the next tick will almost certainly recover it.
        if (!cancelled) setStale(true);
      }
    }

    const timer = setInterval(poll, every);
    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [domain, every]);

  return (
    <div className="flex items-center gap-3.5">
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span
          className="pulse-ring absolute inline-flex h-full w-full rounded-full"
          style={{ background: stale ? 'var(--accent)' : 'var(--live)' }}
        />
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: stale ? 'var(--accent)' : 'var(--live)' }}
        />
      </span>

      <div>
        <div className="legend">{stale ? 'reconnecting' : 'current visitors'}</div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span
            className={`tnum text-4xl leading-none font-semibold tracking-tight tabular-nums${
              ticked ? ' tick-flash' : ''
            }`}
            style={{ borderRadius: 3, padding: '0 4px', margin: '0 -4px' }}
            aria-live="polite"
          >
            {count.toLocaleString()}
          </span>
          <span className="text-ink-3 text-xs">in the last 5 min</span>
        </div>
      </div>
    </div>
  );
}
