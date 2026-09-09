import { getMasterInboxSupabase as createServerSupabase } from "../supabase";
import { loadViewBySlug, type CustomView } from "./views";
import { searchThreads } from "./search";
import { OPEN_RESPONSES_PRESET, openResponsesThreadIds } from "./open-responses";
import { fetchAllRows } from "../db/paginated-select";
import type { FilterRow, FilterState } from "./filters";

export type SourceProvider = "emailbison" | "instantly";

export interface ThreadRow {
  id: string;
  subject: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  needs_reply: boolean;
  seen: boolean;
  lead_full_name: string | null;
  lead_email: string | null;
  lead_company: string | null;
  channel_provider: SourceProvider | null;
  source_provider: SourceProvider | null;
  client_name: string | null;
  client_slug: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  labels: Array<{ name: string; color: string }>;
}

type Q = ReturnType<ReturnType<Awaited<ReturnType<typeof createServerSupabase>>["from"]>["select"]>;

// Resolve the active FilterState for a request. Priority:
//   1. URL `?f=` (ad-hoc filter from FilterBuilder Apply)
//   2. custom_view.filter_json (when the view was saved with rows)
//   3. legacy preset on the view (preset: "all_email" etc.)
// Rows rendered per list page. The list is NOT virtualized, so every row
// is serialized into the RSC payload, rendered to HTML, and hydrated on
// the client on every load AND every thread switch. At 100 that was a
// large repeated cost (a big chunk of the "opening a thread is slow"
// complaint) even for a tiny conversation. 50 halves that work; the
// sidebar rail is only 300px wide, so nobody scrolls 100 rows there —
// search, filters, and pagination cover deeper lists.
export const THREAD_PAGE_SIZE = 50;

export interface ThreadListResult {
  rows: ThreadRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function loadThreads(
  workspaceId: string,
  view: string,
  filterFromUrl: FilterState | null,
  listId: string | null = null,
  page = 1,
  searchQuery: string | null = null,
): Promise<ThreadListResult> {
  const supabase = await createServerSupabase();

  // Top-bar search: when a `?q=` is present we restrict the view to the
  // threads that match it — the result renders in the normal thread list,
  // not a separate page. Resolve the matching ids up front; no matches →
  // empty result.
  let searchThreadIds: string[] | null = null;
  if (searchQuery && searchQuery.trim().length >= 2) {
    const hits = await searchThreads(workspaceId, searchQuery.trim(), 500);
    searchThreadIds = hits.map((h) => h.id);
    if (searchThreadIds.length === 0) {
      return {
        rows: [],
        total: 0,
        page: Math.max(1, Math.floor(page)),
        pageSize: THREAD_PAGE_SIZE,
      };
    }
  }

  // If a list filter is active, resolve which mode to use:
  //   - lists.client_id set ("live" list seeded one-per-client) → narrow
  //     by threads.client_id directly. Cleanest path; no UUIDs embedded
  //     in JSON.
  //   - filter_json set (live list with a custom filter — speculative,
  //     not used by the current seed but kept for future extensions) →
  //     fold its rows into the effective FilterState below.
  //   - both null (legacy manually-curated lists) → restrict by
  //     thread_list_items membership.
  const pageSize = THREAD_PAGE_SIZE;
  const safePage = Math.max(1, Math.floor(page));

  let listFilterRows: FilterRow[] = [];
  let listClientId: string | null = null;
  let listThreadIds: string[] | null = null;
  if (listId) {
    const { data: listRow } = await supabase
      .from("lists")
      .select("client_id, filter_json")
      .eq("id", listId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    listClientId = (listRow?.client_id as string | null) ?? null;
    if (!listClientId) {
      const fj = (listRow?.filter_json as { rows?: FilterRow[] } | null) ?? null;
      if (fj?.rows && fj.rows.length > 0) {
        listFilterRows = fj.rows;
      } else {
        const { data } = await supabase
          .from("thread_list_items")
          .select("thread_id")
          .eq("list_id", listId)
          .eq("workspace_id", workspaceId);
        listThreadIds = (data ?? []).map((r) => r.thread_id as string);
        if (listThreadIds.length === 0) {
          return { rows: [], total: 0, page: safePage, pageSize };
        }
      }
    }
  }

  // Resolve the custom view (non-system slugs) up front. Needed to apply
  // the view's SQL preset AND to read its saved filter rows. System slugs
  // (all-email / archive / spam / trash) skip this Supabase round-trip —
  // the common case, since users live on /inbox/all-email.
  let cv: CustomView | null = null;
  const systemView =
    view === "archive" || view === "spam" || view === "trash" || view === "all-email";
  if (!systemView) {
    cv = await loadViewBySlug(workspaceId, view);
  }

  // "Open Responses" — an OR-of-two-conditions view the FilterBuilder
  // can't express. Resolve the matching thread ids up front and restrict
  // the query to them (same pattern as the top-bar search path).
  let openResponseIds: string[] | null = null;
  if ((cv?.filter_json as { preset?: string } | undefined)?.preset === OPEN_RESPONSES_PRESET) {
    const set = await openResponsesThreadIds(supabase, workspaceId);
    if (set.size === 0) {
      return { rows: [], total: 0, page: safePage, pageSize };
    }
    openResponseIds = Array.from(set);
  }

  // Effective FilterState: URL > view.filter_json.rows
  const viewRows = (cv?.filter_json as { rows?: FilterRow[] } | undefined)?.rows;
  const state: FilterState =
    filterFromUrl && filterFromUrl.rows.length > 0
      ? filterFromUrl
      : viewRows
        ? { rows: viewRows }
        : { rows: [] };

  // Fold the list's own filter_json rows (live lists, e.g. "client = X")
  // into the active rows. Listing in a live list = "show me threads
  // matching this filter, narrowed further by whatever filter rows the
  // view / URL is applying on top".
  const activeRows: FilterRow[] = [...state.rows, ...listFilterRows];

  // Post-SQL predicates (domain/name/email) run over the mapped page
  // below via filterPredicateForRow; applyRowToQuery only needs this
  // array to satisfy its signature.
  const postFilters: Array<(t: ThreadRow & { _raw: Record<string, unknown> }) => boolean> = [];

  // Query factory. supabase-js builders are single-use — awaiting one
  // executes and mutates it — so every execution path and every chunk
  // asks makeQuery for a fresh builder with the same filters applied.
  //
  // `count: 'exact'` is honored ONLY on this first .select()
  // (PostgrestQueryBuilder); a chained .select() silently drops the
  // option. So callers that need the total request withCount here.
  const makeQuery = (cols: string, withCount: boolean) => {
    let q = (
      withCount
        ? supabase.from("threads").select(cols, { count: "exact" })
        : supabase.from("threads").select(cols)
    ).eq("workspace_id", workspaceId);
    if (view === "archive") q = q.eq("status", "archived") as typeof q;
    else if (view === "spam") q = q.eq("status", "spam") as typeof q;
    else if (view === "trash") q = q.eq("status", "trash") as typeof q;
    else if (view === "all-email") q = q.eq("status", "open") as typeof q;
    else q = applyViewPreset(q as unknown as Q, cv) as typeof q;
    if (listClientId) q = q.eq("client_id", listClientId) as typeof q;
    for (const row of activeRows) {
      if (!row.enabled) continue;
      q = applyRowToQuery(q as unknown as Q, row, workspaceId, supabase, postFilters) as typeof q;
    }
    return q;
  };

  // Resolve any async label/channel filter expansions first.
  const resolved = await Promise.all(
    activeRows
      .filter((r) => r.enabled)
      .map((r) => prepRow(r, workspaceId, supabase)),
  );

  // ID-restriction collection
  // -------------------------
  // Several signals narrow the visible set by thread id: prepRow's
  // idIn lists (label filters), listThreadIds (manual thread_list
  // membership), searchThreadIds (top-bar search), openResponseIds
  // ("Open Responses" preset). Each one is a set of thread UUIDs.
  //
  // Passing them all to `.in("id", …)` would encode thousands of UUIDs
  // in the URL and overshoot Node's 16 KB header cap (fetch throws
  // HeadersOverflowError and the page silently renders empty — the old
  // "Not Interested can't be clicked" bug). So we resolve them to
  // in-memory sets instead. Logical AND across restriction sets; any
  // exclusion set that contains an id disqualifies it.
  const idRestrictionSets: Set<string>[] = [];
  const idNotInSets: Set<string>[] = [];
  for (const r of resolved) {
    if (r?.idIn !== undefined) {
      if (r.idIn.length === 0) {
        return { rows: [], total: 0, page: safePage, pageSize };
      }
      idRestrictionSets.push(new Set(r.idIn));
    }
    if (r?.idNotIn !== undefined && r.idNotIn.length > 0) {
      idNotInSets.push(new Set(r.idNotIn));
    }
  }
  if (listThreadIds !== null) idRestrictionSets.push(new Set(listThreadIds));
  if (searchThreadIds !== null) idRestrictionSets.push(new Set(searchThreadIds));
  if (openResponseIds !== null) idRestrictionSets.push(new Set(openResponseIds));

  const detailCols = `id, subject, last_message_at, last_message_preview, needs_reply, seen, message_count, source_provider, campaign_id, campaign_name,
       leads:lead_id(full_name, email, company),
       channels:channel_id(provider),
       clients:client_id(name, slug)`;
  const offset = (safePage - 1) * pageSize;

  // Hydrate the heavy detail columns for just the visible page. `.in()`
  // doesn't guarantee order, so re-project into the given page order.
  // ~50 ids → ~1.9 KB URL, well under the PostgREST header cap.
  const hydratePage = async (
    pageIds: string[],
  ): Promise<Record<string, unknown>[] | null> => {
    if (pageIds.length === 0) return [];
    const { data: hydrated, error: hydrateErr } = await supabase
      .from("threads")
      .select(detailCols)
      .eq("workspace_id", workspaceId)
      .in("id", pageIds);
    if (hydrateErr) {
      console.error("[loadThreads] hydrate failed", hydrateErr);
      return null;
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const h of (hydrated ?? []) as Record<string, unknown>[]) {
      byId.set(h.id as string, h);
    }
    return pageIds
      .map((id) => byId.get(id))
      .filter((r): r is Record<string, unknown> => Boolean(r));
  };

  // Order by last_message_at desc, nulls last — the SQL order the fast
  // path gets for free. ISO-8601 strings compare lexicographically =
  // chronologically, so no Date parsing needed.
  const byLastMessageDesc = (
    a: { last_message_at: string | null },
    b: { last_message_at: string | null },
  ) => {
    if (a.last_message_at === b.last_message_at) return 0;
    if (a.last_message_at === null) return 1;
    if (b.last_message_at === null) return -1;
    return a.last_message_at < b.last_message_at ? 1 : -1;
  };

  let ordered: Record<string, unknown>[] = [];
  let total = 0;

  if (idRestrictionSets.length === 0 && idNotInSets.length === 0) {
    // FAST PATH — no id restrictions. One query; the DB does count +
    // range and ~pageSize rows come back.
    //
    // Trade-off: post-filters (domain, name, email) still run client-
    // side, so the displayed total can be slightly off when they
    // exclude rows. Accepted; post-filters are rare in the typical view.
    const pagedQuery = (
      makeQuery(detailCols, true).order("last_message_at", {
        ascending: false,
        nullsFirst: false,
      }) as unknown as {
        range(from: number, to: number): Promise<{
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
          count: number | null;
        }>;
      }
    ).range(offset, offset + pageSize - 1);

    const { data, error, count } = await pagedQuery;
    if (error) {
      console.error("[loadThreads] page query failed", error);
      return { rows: [], total: 0, page: safePage, pageSize };
    }
    total = count ?? data?.length ?? 0;
    ordered = data ?? [];
  } else if (idRestrictionSets.length > 0) {
    // BOUNDED SAFE PATH — the fix for the 5-6s clicks.
    //
    // The restriction sets ARE thread-id sets (a label's threads, a
    // list's threads, search hits, the Open Responses bucket). Intersect
    // them in memory first (no DB), then fetch ONLY those candidate
    // threads that also pass the SQL filters. Work is bounded by the most
    // selective set — a 232-thread "Interested" view touches ~232 rows,
    // not the entire ~20k open-thread table the old full-drain walked in
    // 15-20 sequential 1000-row windows (that was the 5-6s spike).
    const sortedSets = [...idRestrictionSets].sort((a, b) => a.size - b.size);
    const smallest = sortedSets[0];
    const candidates: string[] = [];
    for (const id of smallest) {
      let ok = true;
      for (let i = 1; i < sortedSets.length; i++) {
        if (!sortedSets[i].has(id)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      let excluded = false;
      for (const s of idNotInSets) {
        if (s.has(id)) {
          excluded = true;
          break;
        }
      }
      if (!excluded) candidates.push(id);
    }
    if (candidates.length === 0) {
      return { rows: [], total: 0, page: safePage, pageSize };
    }

    // Fetch light {id, last_message_at} for the candidates that also pass
    // the SQL filters (status=open, client, campaign, …), in URL-safe
    // 300-id chunks, in parallel. Most views are a single chunk.
    const CHUNK = 300;
    const chunks: string[][] = [];
    for (let i = 0; i < candidates.length; i += CHUNK) {
      chunks.push(candidates.slice(i, i + CHUNK));
    }
    // Run the chunk queries with bounded concurrency (batches of 6) so a
    // pathologically large label (dozens of chunks) can't open dozens of
    // simultaneous pooler connections. The common case is a single chunk.
    let chunkError: { message: string } | null = null;
    const runChunk = async (slice: string[]) => {
      const { data, error } = (await (
        makeQuery("id, last_message_at", false).in("id", slice) as unknown as PromiseLike<{
          data: { id: string; last_message_at: string | null }[] | null;
          error: { message: string } | null;
        }>
      )) as {
        data: { id: string; last_message_at: string | null }[] | null;
        error: { message: string } | null;
      };
      if (error) {
        chunkError = error;
        return [] as { id: string; last_message_at: string | null }[];
      }
      return data ?? [];
    };
    const BATCH = 6;
    const collected: { id: string; last_message_at: string | null }[] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(runChunk));
      for (const r of results) collected.push(...r);
      if (chunkError) break;
    }
    if (chunkError) {
      console.error("[loadThreads] bounded safe-path chunk failed", chunkError);
      return { rows: [], total: 0, page: safePage, pageSize };
    }
    const matching = collected.sort(byLastMessageDesc);
    total = matching.length;
    const pageIds = matching.slice(offset, offset + pageSize).map((r) => r.id);
    const hydrated = await hydratePage(pageIds);
    if (hydrated === null) return { rows: [], total, page: safePage, pageSize };
    ordered = hydrated;
  } else {
    // EXCLUSION-ONLY fallback — a labels-NOT view with no positive
    // restriction to bound by. There's no smaller candidate set, so drain
    // the filtered open-thread list (light cols) and apply the exclusion
    // in memory. Rare, and unavoidable without a positive anchor.
    const orderedQuery = makeQuery("id, last_message_at", true).order("last_message_at", {
      ascending: false,
      nullsFirst: false,
    });
    let safePathError: { message: string } | null = null;
    const allRows = await fetchAllRows<{ id: string; last_message_at: string | null }>(
      ({ from, to }) =>
        (orderedQuery as unknown as {
          range(from: number, to: number): PromiseLike<{
            data: { id: string; last_message_at: string | null }[] | null;
            error: { message: string } | null;
          }>;
        }).range(from, to),
    ).catch((err: Error) => {
      safePathError = { message: err.message };
      return [] as { id: string; last_message_at: string | null }[];
    });
    if (safePathError) {
      console.error("[loadThreads] exclusion-path query failed", safePathError);
      return { rows: [], total: 0, page: safePage, pageSize };
    }
    const matching = allRows.filter((r) => {
      if (!r.id) return false;
      for (const s of idNotInSets) if (s.has(r.id)) return false;
      return true;
    });
    total = matching.length;
    const pageIds = matching.slice(offset, offset + pageSize).map((r) => r.id);
    const hydrated = await hydratePage(pageIds);
    if (hydrated === null) return { rows: [], total, page: safePage, pageSize };
    ordered = hydrated;
  }

  if (ordered.length === 0) {
    return { rows: [], total, page: safePage, pageSize };
  }

  // Fetch label_assignments only for the visible page of threads. The
  // older "fetch every assignment in the workspace" path silently hit
  // PostgREST's 1000-row default cap once the workspace passed ~1k AI
  // labels — the most recent inbox rows stopped showing their chips
  // because their assignments fell outside the truncated window.
  // Filtering by `target_id IN (visible thread ids)` keeps payload
  // small (≤ pageSize × labels-per-thread rows) and scales linearly.
  const visibleIds = ordered
    .map((r) => (r as { id?: string }).id)
    .filter((id): id is string => typeof id === "string");
  const { data: assignments } = visibleIds.length
    ? await supabase
        .from("label_assignments")
        .select("target_id, labels:label_id(name, color)")
        .eq("workspace_id", workspaceId)
        .eq("target_type", "thread")
        .in("target_id", visibleIds)
    : { data: [] as unknown[] };

  const labelsByThread = new Map<string, Array<{ name: string; color: string }>>();
  for (const r of assignments ?? []) {
    const ra = r as { target_id: string; labels: { name: string; color: string } | { name: string; color: string }[] | null };
    const label = Array.isArray(ra.labels) ? ra.labels[0] : ra.labels;
    if (!label) continue;
    const list = labelsByThread.get(ra.target_id) ?? [];
    list.push({ name: label.name, color: label.color });
    labelsByThread.set(ra.target_id, list);
  }

  type Lead = { full_name?: string | null; email?: string | null; company?: string | null };
  type Channel = { provider?: SourceProvider | null };
  type Client = { name?: string | null; slug?: string | null };
  let mapped: ThreadRow[] = ordered.map((rawRow) => {
    const row = rawRow as Record<string, unknown> & {
      id: string;
      leads: Lead | Lead[] | null;
      channels: Channel | Channel[] | null;
      clients: Client | Client[] | null;
    };
    const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads;
    const channel = Array.isArray(row.channels) ? row.channels[0] : row.channels;
    const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
    return {
      id: row.id,
      subject: (row.subject as string | null) ?? null,
      last_message_at: (row.last_message_at as string | null) ?? null,
      last_message_preview: (row.last_message_preview as string | null) ?? null,
      needs_reply: Boolean(row.needs_reply),
      seen: (row.seen as boolean | null) ?? true,
      lead_full_name: lead?.full_name ?? null,
      lead_email: lead?.email ?? null,
      lead_company: lead?.company ?? null,
      channel_provider: (channel?.provider ?? null) as ThreadRow["channel_provider"],
      // Prefer the denormalised source_provider on the thread (set at sync
      // time) — falls back to the channel's provider for legacy rows that
      // haven't been re-synced since the 0010 migration.
      source_provider:
        ((row.source_provider as SourceProvider | null) ??
          (channel?.provider as SourceProvider | null) ??
          null),
      client_name: client?.name ?? null,
      client_slug: client?.slug ?? null,
      campaign_id: (row.campaign_id as string | null) ?? null,
      campaign_name: (row.campaign_name as string | null) ?? null,
      labels: labelsByThread.get(row.id) ?? [],
    };
  });

  // Apply post-SQL filters (domain match, etc.) — uses the same
  // activeRows that drove the SQL-level filter chain so live-list
  // narrowing isn't dropped at the post-filter pass.
  for (const row of activeRows) {
    if (!row.enabled) continue;
    mapped = mapped.filter(filterPredicateForRow(row));
  }

  return {
    rows: mapped,
    total,
    page: safePage,
    pageSize,
  };
}

function applyViewPreset(query: Q, view: CustomView | null): Q {
  if (!view) return query.eq("status", "open") as Q;
  const f = view.filter_json as { preset?: string };
  switch (f.preset) {
    case "needs_reply":
      return query.eq("status", "open").eq("needs_reply", true) as Q;
    case "all_email":
    case "custom_filter":
    case OPEN_RESPONSES_PRESET:
      // open_responses: base filter is status=open; the OR membership is
      // applied as an id restriction back in loadThreads.
      return query.eq("status", "open") as Q;
    case "engaged":
      return query.eq("status", "open").gte("message_count", 3) as Q;
    default:
      return query.eq("status", "open") as Q;
  }
}

// Apply a row's SQL-expressible conditions directly. Returns the chained query.
// Label and channel rows are handled via prepRow (async — needs id lookups).
function applyRowToQuery(
  query: Q,
  row: FilterRow,
  _workspaceId: string,
  _supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  _post: Array<(t: ThreadRow & { _raw: Record<string, unknown> }) => boolean>,
): Q {
  switch (row.field) {
    case "subject": {
      const text = String(row.value ?? "").trim();
      if (!text) return query;
      return query.ilike("subject", `%${text}%`) as Q;
    }
    case "message_counts": {
      const n = Number(row.value);
      if (!Number.isFinite(n)) return query;
      // We use thread.message_count as a proxy for both sent + received until
      // dedicated denormalised counters land in the schema.
      if (row.operator === "equals") return query.eq("message_count", n) as Q;
      if (row.operator === "greater_than") return query.gt("message_count", n) as Q;
      if (row.operator === "less_than") return query.lt("message_count", n) as Q;
      return query;
    }
    case "reply_since": {
      // reply_since: ">3 days" => last_message_at older than 3 days ago.
      const days = Number(row.value);
      if (!Number.isFinite(days)) return query;
      const threshold = new Date(Date.now() - days * 86400_000).toISOString();
      if (row.operator === "greater_than") return query.lt("last_message_at", threshold) as Q;
      if (row.operator === "less_than") return query.gt("last_message_at", threshold) as Q;
      return query;
    }
    case "last_message_from":
      // Approximated via threads.needs_reply: needs_reply=false ⇒ last from Me,
      // needs_reply=true ⇒ last from Lead. Refined when we add a denormalised
      // last_direction column.
      if (row.value === "me") return query.eq("needs_reply", false) as Q;
      if (row.value === "lead") return query.eq("needs_reply", true) as Q;
      return query;
    case "channels": {
      const ids = Array.isArray(row.value) ? (row.value as string[]) : [];
      if (ids.length === 0) return query;
      if (row.operator === "is") return query.in("channel_id", ids) as Q;
      if (row.operator === "not") return query.not("channel_id", "in", `(${ids.join(",")})`) as Q;
      return query;
    }
    case "campaigns": {
      // Values are campaign_id strings (text). Empty list means "no filter".
      const ids = Array.isArray(row.value) ? (row.value as string[]) : [];
      if (ids.length === 0) return query;
      if (row.operator === "is") return query.in("campaign_id", ids) as Q;
      if (row.operator === "not") {
        // PostgREST string interpolation: campaign_id values are opaque
        // (UUIDs or numeric strings) — no embedded commas — so a simple
        // join is safe.
        return query.not("campaign_id", "in", `(${ids.join(",")})`) as Q;
      }
      return query;
    }
    case "clients": {
      // Values are client_id UUIDs. Empty list means "no filter".
      const ids = Array.isArray(row.value) ? (row.value as string[]) : [];
      if (ids.length === 0) return query;
      if (row.operator === "is") return query.in("client_id", ids) as Q;
      if (row.operator === "not") {
        return query.not("client_id", "in", `(${ids.join(",")})`) as Q;
      }
      return query;
    }
    default:
      return query;
  }
}

// Async label / channel resolution. For label IS / NOT we need a list of
// thread ids that have ANY of the selected labels.
async function prepRow(
  row: FilterRow,
  workspaceId: string,
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
): Promise<{ idIn?: string[]; idNotIn?: string[] } | null> {
  if (row.field !== "labels") return null;
  const ids = Array.isArray(row.value) ? (row.value as string[]) : [];
  if (ids.length === 0) return null;

  // Page past PostgREST's 1000-row cap. Supabase has
  // db-max-rows=1000 set server-side; a single .range(0, 49_999)
  // request comes back as `Content-Range: 0-999/<total>` no matter
  // what range the client asks for. Drain by paging in 1000-row
  // windows. Missing this leaks excluded threads back into the
  // result (e.g. a labels-NOT filter pointing at >1000 assignments
  // would only exclude the first 1000 and the rest leak through —
  // the exact symptom of the Brokers/Owners view bug).
  const rows = await fetchAllRows<{ target_id: string }>(({ from, to }) =>
    supabase
      .from("label_assignments")
      .select("target_id")
      .eq("workspace_id", workspaceId)
      .eq("target_type", "thread")
      .in("label_id", ids)
      .range(from, to),
  );
  const targetIds = Array.from(new Set(rows.map((r) => r.target_id)));

  if (row.operator === "is") return { idIn: targetIds };
  if (row.operator === "not") return { idNotIn: targetIds };
  return null;
}

// Post-SQL row predicates (for fields that can't be expressed in one Supabase
// chain — currently domain matching against lead.email).
function filterPredicateForRow(row: FilterRow): (t: ThreadRow) => boolean {
  switch (row.field) {
    case "domain": {
      const needle = String(row.value ?? "").trim().toLowerCase();
      if (!needle) return () => true;
      return (t) => (t.lead_email ?? "").toLowerCase().endsWith(`@${needle}`) || (t.lead_email ?? "").toLowerCase().includes(needle);
    }
    case "name": {
      const needle = String(row.value ?? "").trim().toLowerCase();
      if (!needle) return () => true;
      if (row.operator === "equals") return (t) => (t.lead_full_name ?? "").toLowerCase() === needle;
      return (t) => (t.lead_full_name ?? "").toLowerCase().includes(needle);
    }
    case "email": {
      const needle = String(row.value ?? "").trim().toLowerCase();
      if (!needle) return () => true;
      if (row.operator === "equals") return (t) => (t.lead_email ?? "").toLowerCase() === needle;
      return (t) => (t.lead_email ?? "").toLowerCase().includes(needle);
    }
    default:
      return () => true;
  }
}
