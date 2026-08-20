/**
 * The ingest route handlers, shared by every path the endpoint is mounted at.
 *
 * Ad blockers match on URL patterns, and `/api/event` is on the lists by name.
 * The tracker therefore posts to a neutral path by default, while the
 * documented `/api/event` stays mounted so the architecture's contract holds
 * and existing installs keep working.
 */
import { ingest, toResponse } from './ingest';

/** Preflight is not expected — the tracker sends a CORS-simple request — but
 *  a custom `data-api` host could trigger one, so answer it correctly. */
export function ingestOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      'cache-control': 'no-store',
    },
  });
}

export async function ingestPost(request: Request): Promise<Response> {
  let body: string;
  try {
    body = await request.text();
  } catch {
    // A truncated or aborted upload. Nothing to record, nothing to say.
    return toResponse({ status: 400, reason: 'malformed' });
  }
  return toResponse(await ingest(body, request.headers));
}

/** Anything other than POST. Answered without touching the store. */
export function ingestMethodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: { allow: 'POST, OPTIONS', 'cache-control': 'no-store' },
  });
}
