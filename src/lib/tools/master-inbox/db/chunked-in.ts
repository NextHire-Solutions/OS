// Safe wrapper around `.in("col", ids)` for any time `ids` could
// realistically grow past a few hundred entries.
//
// Why this exists
// ---------------
// PostgREST encodes `.in("col", values)` as a URL query parameter.
// At ~400 UUIDs the URL crosses Node's 16 KB header cap and the
// undici-based fetch throws HeadersOverflowError. The server then
// silently treats it as an empty result, which surfaced as the "Not
// Interested" inbox view loading an empty list (441 matching
// threads, 16,381-byte URL). The same trap waits for any future
// view, filter, or bulk action whose id list grows.
//
// What this does
// --------------
// Splits `ids` into chunks small enough that each request URL stays
// under ~11 KB and runs them in parallel via a caller-supplied
// builder. Designed for `DELETE` and `UPDATE` operations where the
// natural shape is one supabase-js call per chunk. For SELECT
// reads with pagination semantics, prefer the in-memory intersect
// pattern in lib/inbox/threads.ts instead — chunking SELECT is more
// nuanced (count + sort across chunks).
//
// CHUNK_DEFAULT was chosen empirically:
//   300 UUIDs × 38 bytes = ~11 KB after `id=in.(…)` framing, well
//   under the 16 KB undici header cap with headroom for the rest of
//   the request line + headers.

export const CHUNK_DEFAULT = 300;

// `fn` is typed as PromiseLike rather than Promise so supabase-js's
// chained filter builders (which are thenable but not full Promises)
// can be returned directly from the callback without an extra await.
export async function chunkedRun<T>(
  ids: string[],
  fn: (slice: string[]) => PromiseLike<T>,
  chunkSize: number = CHUNK_DEFAULT,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    out.push(await fn(ids.slice(i, i + chunkSize)));
  }
  return out;
}
