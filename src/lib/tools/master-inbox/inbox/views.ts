import { cache } from "react";
import { getMasterInboxSupabase as createServerSupabase } from "../supabase";
import { OPEN_RESPONSES_PRESET } from "./open-responses";

export type { CustomView } from "./views-shared";
export { slugifyView } from "./views-shared";

import type { CustomView } from "./views-shared";
import { slugifyView } from "./views-shared";

// React.cache dedupes within ONE render (when several server components
// need the views list during the same request, the query runs once).
//
// We dropped the 30s cross-request ttlCache because Railway can scale
// to multiple Node workers and the cache is in-memory per-worker — an
// invalidate() call after a drag PATCH would only clear the cache on
// whichever worker handled the PATCH. The next request could land on a
// different worker still holding the stale 30s window, and the user
// would see the dragged tab snap back. Views queries are small (~10
// rows) so the cost of refetching per request is negligible.
async function fetchViews(workspaceId: string): Promise<CustomView[]> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("custom_views")
    .select("id, name, icon, filter_json, sort_order, is_system")
    .eq("workspace_id", workspaceId)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[loadViews] query failed", error);
    return [];
  }

  return (data ?? []).map((v) => ({
    id: v.id as string,
    name: v.name as string,
    slug: slugifyView(v.name as string),
    icon: (v.icon ?? null) as string | null,
    filter_json: (v.filter_json ?? {}) as Record<string, unknown>,
    sort_order: v.sort_order as number,
    is_system: v.is_system as boolean,
  }));
}

export const loadViews = cache(fetchViews);

// Kept as a no-op so existing mutation routes can call it without
// caring whether a TTL cache is in play. If we re-introduce
// cross-request caching for views later (e.g. via Redis) the
// implementation re-attaches here without touching every caller.
export function invalidateViewsCache(_workspaceId?: string) {
  /* no-op — see fetchViews comment above */
}

// Resolve a URL slug to its CustomView. Returns null if the slug doesn't
// match any view in the workspace. Sidebar items (archive/spam/trash) are
// NOT custom_views — callers handle those separately.
export const loadViewBySlug = cache(async function loadViewBySlug(
  workspaceId: string,
  slug: string,
): Promise<CustomView | null> {
  const views = await loadViews(workspaceId);
  return views.find((v) => v.slug === slug) ?? null;
});

interface FilterRowLite {
  field?: string;
  value?: unknown;
}

export interface ViewCount {
  unseen: number; // drives the "N new" pill
  // Share of all open threads that carry this view's label. null for
  // views that aren't a single-label filter (e.g. "All Email").
  pct: number | null;
}

// Computes, per TabBar view: the "N new" unseen count AND the percentage
// of all open threads carrying that view's label ("40% Interested" etc.).
//
// Backed by the inbox_view_counts SQL aggregate (migration 0058) — ONE
// server-side call returns totals, per-label all/unseen, and the Open
// Responses bucket. This replaced a per-render drain of every open
// thread + all their label assignments + a messages walk (~2.1s of
// round-trip amplification on EVERY thread open). `listId` narrows
// everything to one client when a sidebar list is active — the RPC
// applies the same scope via its p_list_client argument.
export const loadViewCounts = cache(async function loadViewCounts(
  workspaceId: string,
  listId?: string | null,
): Promise<Record<string, ViewCount>> {
  const supabase = await createServerSupabase();
  const views = await loadViews(workspaceId);

  let listClientId: string | null = null;
  if (listId) {
    const { data: listRow } = await supabase
      .from("lists")
      .select("client_id")
      .eq("id", listId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    listClientId = (listRow?.client_id as string | null) ?? null;
  }

  const { data: rpcRows, error } = await supabase.rpc("inbox_view_counts", {
    p_ws: workspaceId,
    p_list_client: listClientId,
  });
  if (error) {
    // Fail safe: render the tab bar without pills rather than break the
    // whole inbox if the aggregate ever errors.
    console.error("[loadViewCounts] inbox_view_counts rpc failed", error);
    return {};
  }

  type CountRow = {
    kind: string;
    label_id: string | null;
    all_ct: number | string;
    unseen_ct: number | string;
  };
  let totalOpen = 0;
  let totalUnseen = 0;
  let openRespAll = 0;
  let openRespUnseen = 0;
  const byLabel = new Map<string, { all: number; unseen: number }>();
  for (const r of (rpcRows ?? []) as CountRow[]) {
    const all = Number(r.all_ct) || 0;
    const unseen = Number(r.unseen_ct) || 0;
    if (r.kind === "total") {
      totalOpen = all;
      totalUnseen = unseen;
    } else if (r.kind === "open_responses") {
      openRespAll = all;
      openRespUnseen = unseen;
    } else if (r.kind === "label" && r.label_id) {
      byLabel.set(r.label_id, { all, unseen });
    }
  }

  const counts: Record<string, ViewCount> = {};
  for (const v of views) {
    const preset = (v.filter_json as { preset?: string } | null)?.preset;
    if (preset === OPEN_RESPONSES_PRESET) {
      counts[v.id] = {
        unseen: openRespUnseen,
        pct: totalOpen > 0 ? Math.round((openRespAll / totalOpen) * 100) : 0,
      };
      continue;
    }
    const rows = ((v.filter_json as { rows?: FilterRowLite[] } | null)?.rows) ?? [];
    if (rows.length === 0) {
      // "All Email" — show the unseen count, no % (it's the whole 100%).
      counts[v.id] = { unseen: totalUnseen, pct: null };
      continue;
    }
    const labelsRow = rows.find((r) => r?.field === "labels");
    if (labelsRow && Array.isArray(labelsRow.value)) {
      const labelIds = labelsRow.value as string[];
      // Every current view is single-label, so this sum equals the one
      // bucket exactly. A hypothetical multi-label view would sum
      // per-label counts (a slight over-count only where a thread
      // carries two of the view's labels) — acceptable for a cosmetic
      // badge, and no such view exists today.
      let allCt = 0;
      let unseenCt = 0;
      for (const lid of labelIds) {
        const bucket = byLabel.get(lid);
        if (!bucket) continue;
        allCt += bucket.all;
        unseenCt += bucket.unseen;
      }
      counts[v.id] = {
        unseen: unseenCt,
        pct: totalOpen > 0 ? Math.round((allCt / totalOpen) * 100) : 0,
      };
      continue;
    }
    counts[v.id] = { unseen: 0, pct: null };
  }
  return counts;
});
