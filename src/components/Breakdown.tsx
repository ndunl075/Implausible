'use client';

import { useState } from 'react';
import { compact, countryFlag, countryName } from '@/lib/format';
import type { BreakdownRow } from '@/lib/stats';

/**
 * A tabbed breakdown table.
 *
 * Each row carries its own share as a bar behind the text rather than beside
 * it. It reads as a ranked list first and a chart second, which is the order
 * people actually use these in, and it keeps the row height honest.
 */

export interface Tab {
  key: string;
  label: string;
  rows: BreakdownRow[];
  /** Renders country codes as flag + name. */
  kind?: 'plain' | 'country';
}

interface Props {
  tabs: Tab[];
  /** Shown when the active tab has no rows. */
  emptyHint?: string;
}

export function Breakdown({ tabs, emptyHint = 'Nothing recorded in this period.' }: Props) {
  const [activeKey, setActiveKey] = useState(tabs[0]?.key ?? '');
  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const rows = active?.rows ?? [];
  const peak = Math.max(1, ...rows.map((row) => row.visitors));

  return (
    <section className="panel flex h-full min-h-[19rem] flex-col">
      <header className="border-rule flex items-center gap-1 border-b px-2 py-2">
        {tabs.map((tab) => {
          const selected = tab.key === active?.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveKey(tab.key)}
              aria-pressed={selected}
              className="legend rounded-sm px-2.5 py-1.5 transition-colors"
              style={{
                color: selected ? 'var(--ink)' : 'var(--ink-3)',
                background: selected ? 'var(--accent-soft)' : 'transparent',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </header>

      {rows.length === 0 ? (
        <p className="text-ink-3 flex flex-1 items-center justify-center px-6 text-center text-sm">
          {emptyHint}
        </p>
      ) : (
        <ol className="flex-1 px-2 py-1.5">
          {rows.map((row, index) => (
            <li key={row.name} className="relative">
              <div
                className="absolute inset-y-0.5 left-0 rounded-[3px]"
                style={{
                  width: `${(row.visitors / peak) * 100}%`,
                  background: 'var(--accent-ghost)',
                  borderLeft: '2px solid var(--accent)',
                  opacity: 0.9,
                }}
                aria-hidden
              />
              <div className="relative flex items-center gap-3 px-2.5 py-[7px] text-[13px]">
                <span className="min-w-0 flex-1 truncate" title={label(row.name, active?.kind)}>
                  {active?.kind === 'country' ? (
                    <>
                      <span aria-hidden className="mr-2">
                        {countryFlag(row.name)}
                      </span>
                      {countryName(row.name)}
                    </>
                  ) : (
                    label(row.name, active?.kind)
                  )}
                </span>
                <span className="tnum text-ink-2 w-14 shrink-0 text-right">
                  {compact(row.visitors)}
                </span>
                <span
                  className="tnum text-ink-3 w-12 shrink-0 text-right text-[11px]"
                  title={`${row.pageviews.toLocaleString()} pageviews`}
                >
                  {compact(row.pageviews)}
                </span>
              </div>
              {index === 0 ? (
                <div className="legend pointer-events-none absolute -top-6 right-2.5 hidden gap-0 sm:flex">
                  <span className="w-14 text-right">visitors</span>
                  <span className="w-12 text-right">views</span>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function label(name: string, kind: Tab['kind']): string {
  if (kind === 'country') return countryName(name);
  return name;
}
