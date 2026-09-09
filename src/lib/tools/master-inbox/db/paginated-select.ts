// Drain a PostgREST `select` past Supabase's server-side `db-max-rows` cap.
//
// Why this exists
// ---------------
// We hit it the first time on the "Not Interested" view: PostgREST's
// default 1000-row cap silently truncated `label_assignments` rows so
// the filter only excluded the first 1000 of 1049 excluded threads.
// The fix-that-wasn't was `.range(0, 49_999)` — Supabase's hosted
// PostgREST has `db-max-rows = 1000` set server-side, and the client's
// Range header can SHRINK but not EXPAND that cap. The server replies
// `Content-Range: 0-999/<total>` regardless of how big a range the
// client asks for.
//
// The only honest way past the cap is to PAGE: ask for 0-999, then
// 1000-1999, then 2000-2999… until the server returns fewer rows than
// a full page (meaning we drained it). Each request is independent so
// the cap can't bite a single request.
//
// What this does
// --------------
// Repeatedly invokes `build(range)` with successive 1000-row windows
// until a short page comes back, then flattens the results. Designed
// for SELECT reads where the caller wants every matching row (label
// assignment lookups, list membership, batch counts).

const PAGE = 1000;

export async function fetchAllRows<T>(
  build: (range: { from: number; to: number }) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data, error } = await build({ from, to: from + PAGE - 1 });
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}
