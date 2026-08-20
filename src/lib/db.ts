/**
 * DuckDB connection and schema.
 *
 * Embedded and single-file: no server to run, no credentials to leak, and the
 * whole dataset is one path on disk that an operator can delete outright.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { config } from './config';
import { SCHEMA } from './schema';

export type Row = Record<string, unknown>;

interface Handle {
  instance: DuckDBInstance;
  connection: DuckDBConnection;
}

async function connect(dbPath: string): Promise<Handle> {
  const { DuckDBInstance } = await import('@duckdb/node-api');

  if (dbPath !== ':memory:') {
    await mkdir(path.dirname(dbPath), { recursive: true });
  }

  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();

  // DuckDB's run() takes one statement at a time.
  for (const statement of SCHEMA) {
    await connection.run(statement);
  }

  return { instance, connection };
}

/**
 * Open handles, keyed by path. A Map rather than a single slot so tests can
 * hold several databases at once without evicting each other's connection.
 *
 * Cached on globalThis so the dev server's hot reload does not open a second
 * handle to the same file.
 */
const globalRef = globalThis as typeof globalThis & {
  __implausibleDb?: Map<string, Promise<Handle>>;
};

function handles(): Map<string, Promise<Handle>> {
  globalRef.__implausibleDb ??= new Map();
  return globalRef.__implausibleDb;
}

/** The connection for a database path, opened on first use. */
export function db(dbPath: string = config.dbPath): Promise<Handle> {
  const open = handles();
  const existing = open.get(dbPath);
  if (existing) return existing;

  const handle = connect(dbPath);
  open.set(dbPath, handle);
  return handle;
}

/** Runs a parameterised query and returns plain JS row objects. */
export async function query<T extends Row = Row>(
  sql: string,
  params: unknown[] = [],
  dbPath?: string,
): Promise<T[]> {
  const { connection } = await db(dbPath);
  const result = await connection.runAndReadAll(
    sql,
    params as Parameters<typeof connection.runAndReadAll>[1],
  );
  return result.getRowObjectsJS() as T[];
}

/** Closes a database handle. Used by tests and graceful shutdown. */
export async function closeDb(dbPath: string = config.dbPath): Promise<void> {
  const open = handles();
  const handle = open.get(dbPath);
  open.delete(dbPath);
  if (!handle) return;

  try {
    const { connection, instance } = await handle;
    connection.closeSync();
    instance.closeSync();
  } catch {
    // Already closed, or never finished opening. Nothing to release.
  }
}
