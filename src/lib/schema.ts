/**
 * The event store schema.
 *
 * Kept as TypeScript rather than a .sql file so it is compiled into the server
 * bundle. A loose .sql read at runtime works in dev and then fails on a
 * deployed build, which is exactly the kind of surprise a schema should not
 * have.
 *
 * ---------------------------------------------------------------------------
 * One append-only table. There is no user table, no profile table, and no join
 * key that outlives a day.
 *
 * What is deliberately absent, and must stay absent (invariant 1):
 *   - the IP address, in raw or reversible form
 *   - the full user-agent string
 *   - the full referrer URL, including its query string
 *   - any identifier that survives a salt rotation
 *
 * visitor_id and session_id are both derived from the current daily salt. When
 * that salt is dropped, the rows written under it stop being connectable to
 * anything written after — which is the point of the whole system.
 * ---------------------------------------------------------------------------
 */

/** Executed in order on every connection. Each entry must be idempotent. */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
     timestamp    TIMESTAMP NOT NULL,
     domain       VARCHAR   NOT NULL,
     pathname     VARCHAR   NOT NULL,
     visitor_id   VARCHAR   NOT NULL,
     session_id   VARCHAR   NOT NULL,
     referrer_src VARCHAR,
     country      VARCHAR,
     device       VARCHAR   NOT NULL,
     browser      VARCHAR   NOT NULL,
     os           VARCHAR   NOT NULL
   )`,

  // Every dashboard query filters by domain and then by a time range, so this
  // is the access path that matters.
  `CREATE INDEX IF NOT EXISTS events_domain_time ON events (domain, timestamp)`,
];

/**
 * Columns in appender order. The appender is positional, so this list and the
 * CREATE TABLE above have to agree — exported so a test can assert they do.
 */
export const EVENT_COLUMNS = [
  'timestamp',
  'domain',
  'pathname',
  'visitor_id',
  'session_id',
  'referrer_src',
  'country',
  'device',
  'browser',
  'os',
] as const;

/** Column names that must never appear in the events table (invariant 1). */
export const FORBIDDEN_COLUMNS = [
  'ip',
  'ip_address',
  'ip_addr',
  'remote_addr',
  'client_ip',
  'user_agent',
  'referrer_url',
  'email',
  'user_id',
] as const;
