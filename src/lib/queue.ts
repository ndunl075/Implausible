/**
 * Asynchronous ingest queue.
 *
 * `POST /api/event` answers 202 the moment a request validates and hands the
 * row to this queue. Nothing about writing to disk is allowed to sit in front
 * of a visitor's page load, so `enqueue` never blocks, never awaits, and never
 * throws — a failure to record a pageview is strictly less bad than a tracker
 * that slows down the site it is measuring.
 *
 * Rows are batched and written through DuckDB's appender, which is a bulk path
 * that avoids re-planning an INSERT for every pageview.
 */
import type { DuckDBAppender } from '@duckdb/node-api';
import { db } from './db';

export interface StoredEvent {
  /** Epoch milliseconds, UTC. */
  timestamp: number;
  domain: string;
  pathname: string;
  visitorId: string;
  sessionId: string;
  /** Null for internal navigation. */
  referrerSrc: string | null;
  /** ISO 3166-1 alpha-2, or null when unknown. */
  country: string | null;
  device: string;
  browser: string;
  os: string;
}

export interface QueueOptions {
  /** Flush once this many rows are waiting. */
  batchSize?: number;
  /** Flush at least this often, even when the batch is not full. */
  intervalMs?: number;
  /**
   * Hard ceiling on buffered rows. Past this, the oldest are dropped: unbounded
   * growth under a traffic spike would take the whole process down, and losing
   * the tail of a spike is the cheaper failure.
   */
  maxPending?: number;
  dbPath?: string;
}

export interface QueueStats {
  pending: number;
  written: number;
  dropped: number;
}

const DEFAULTS = {
  batchSize: 512,
  intervalMs: 1_000,
  maxPending: 50_000,
} as const;

export class IngestQueue {
  private buffer: StoredEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private appender: DuckDBAppender | null = null;
  /** Serialises flushes so two batches never touch the appender at once. */
  private chain: Promise<void> = Promise.resolve();
  private written = 0;
  private dropped = 0;
  private closed = false;

  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly maxPending: number;
  private readonly dbPath: string | undefined;

  constructor(options: QueueOptions = {}) {
    this.batchSize = options.batchSize ?? DEFAULTS.batchSize;
    this.intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
    this.maxPending = options.maxPending ?? DEFAULTS.maxPending;
    this.dbPath = options.dbPath;
  }

  /** Accepts an event for writing. Synchronous, non-throwing, fire-and-forget. */
  enqueue(event: StoredEvent): void {
    if (this.closed) return;

    if (this.buffer.length >= this.maxPending) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(event);

    if (this.buffer.length >= this.batchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  /** Writes everything buffered and resolves once it is durable. */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.drain()).catch(() => {});
    return this.chain;
  }

  stats(): QueueStats {
    return {
      pending: this.buffer.length,
      written: this.written,
      dropped: this.dropped,
    };
  }

  /** Flushes and releases the appender. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    this.releaseAppender();
  }

  private scheduleFlush(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.intervalMs);
    // Never hold the process open just to flush analytics.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      await this.write(batch);
    }
  }

  private async write(batch: StoredEvent[]): Promise<void> {
    try {
      await this.append(batch);
      this.written += batch.length;
      return;
    } catch {
      // Most likely a stale appender after a reconnect. Drop it and retry once
      // with a fresh one before giving up on the batch.
      this.releaseAppender();
    }

    try {
      await this.append(batch);
      this.written += batch.length;
    } catch (error) {
      this.dropped += batch.length;
      this.releaseAppender();
      // Safe to log: every field in a StoredEvent is already anonymised, and
      // only the count and the message are printed regardless.
      console.error(
        `[implausible] dropped ${batch.length} events: ` +
          (error instanceof Error ? error.message : 'unknown write error'),
      );
    }
  }

  private async append(batch: StoredEvent[]): Promise<void> {
    const appender = await this.getAppender();

    for (const event of batch) {
      // Column order must match schema.sql exactly — the appender is positional.
      appender.appendTimestamp(await micros(event.timestamp));
      appender.appendVarchar(event.domain);
      appender.appendVarchar(event.pathname);
      appender.appendVarchar(event.visitorId);
      appender.appendVarchar(event.sessionId);
      appendNullable(appender, event.referrerSrc);
      appendNullable(appender, event.country);
      appender.appendVarchar(event.device);
      appender.appendVarchar(event.browser);
      appender.appendVarchar(event.os);
      appender.endRow();
    }

    appender.flushSync();
  }

  private async getAppender(): Promise<DuckDBAppender> {
    if (!this.appender) {
      const { connection } = await db(this.dbPath);
      this.appender = await connection.createAppender('events');
    }
    return this.appender;
  }

  private releaseAppender(): void {
    try {
      this.appender?.closeSync();
    } catch {
      // Already invalid; the point was only to stop reusing it.
    }
    this.appender = null;
  }
}

function appendNullable(appender: DuckDBAppender, value: string | null): void {
  if (value === null) appender.appendNull();
  else appender.appendVarchar(value);
}

async function micros(epochMs: number) {
  const { DuckDBTimestampValue } = await import('@duckdb/node-api');
  return new DuckDBTimestampValue(BigInt(Math.trunc(epochMs)) * 1000n);
}

const globalRef = globalThis as typeof globalThis & {
  __implausibleQueue?: IngestQueue;
};

export function ingestQueue(): IngestQueue {
  if (!globalRef.__implausibleQueue) {
    const queue = new IngestQueue();
    globalRef.__implausibleQueue = queue;

    // A rolling deploy should not cost the last second of traffic.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        void queue.close();
      });
    }
    process.once('beforeExit', () => {
      void queue.flush();
    });
  }
  return globalRef.__implausibleQueue;
}
