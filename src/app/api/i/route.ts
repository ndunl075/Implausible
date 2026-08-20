/**
 * The neutral ingest path the tracker posts to by default.
 *
 * `/api/event` is on ad-blocker lists by name; this one is not, which is the
 * only reason it exists. Both mount the same handler.
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
