/**
 * The documented ingest path.
 *
 * Kept mounted so the architecture's contract holds and any install pointing
 * here keeps working, but the tracker defaults to /api/i because ad blockers
 * match this path by name.
 */
import {
  ingestMethodNotAllowed,
  ingestOptions,
  ingestPost,
} from '@/lib/route';

// DuckDB is a native module, so this cannot run on the edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = ingestPost;
export const OPTIONS = ingestOptions;
export const GET = ingestMethodNotAllowed;
export const HEAD = ingestMethodNotAllowed;
