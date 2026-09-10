import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import type { ListRow } from "./lists-shared";

export type { ListRow } from "./lists-shared";

async function fetchLists(workspaceId: string): Promise<ListRow[]> {
  const supabase = await createServerSupabase();

  // Pull the lists + the two recency aggregates in parallel.
  //
  // Two tiers drive the order:
  //   • TIER 1 — client_unseen_inbox_activity (migration 0045):
  //     max sent_at of an inbound message on a thread that is
  //     still UNSEEN. This is the operator's primary signal —
  //     "which client has a reply I haven't opened yet?".
  //   • TIER 2 — client_inbox_activity (migration 0044): max
  //     sent_at of any inbound, seen or not. Used for clients
  //     whose unread activity has all been triaged so they still
  //     order by most-recently-active rather than dropping into
  //     a flat alphabetical tail.
  //
  // Outbound replies deliberately don't reshuffle (operator's
  // pick) — see view definitions.
  const [listsResp, unseenResp, activityResp] = await Promise.all([
    supabase
      .from("lists")
      .select("id, name, icon, sort_order, shared, client_id")
      .eq("workspace_id", workspaceId),
    supabase
      .from("client_unseen_inbox_activity")
      .select("client_id, last_unseen_inbound_at")
      .eq("workspace_id", workspaceId),
    supabase
      .from("client_inbox_activity")
      .select("client_id, last_inbound_at")
      .eq("workspace_id", workspaceId),
  ]);

  if (listsResp.error) {
    console.error("[loadLists] query failed", listsResp.error);
    return [];
  }
  if (unseenResp.error) {
    // Don't fail the whole sidebar if either view trips. We
    // gracefully degrade to the next tier (and ultimately
    // alphabetical) so the page still renders.
    console.error("[loadLists] unseen-activity query failed", unseenResp.error);
  }
  if (activityResp.error) {
    console.error("[loadLists] activity query failed", activityResp.error);
  }

  type ListRowWithClient = ListRow & { client_id: string | null };
  const rows = (listsResp.data ?? []) as ListRowWithClient[];

  const unseenByClient = new Map<string, string>();
  for (const a of (unseenResp.data ?? []) as Array<{
    client_id: string | null;
    last_unseen_inbound_at: string | null;
  }>) {
    if (a.client_id && a.last_unseen_inbound_at) {
      unseenByClient.set(a.client_id, a.last_unseen_inbound_at);
    }
  }
  const lastInboundByClient = new Map<string, string>();
  for (const a of (activityResp.data ?? []) as Array<{
    client_id: string | null;
    last_inbound_at: string | null;
  }>) {
    if (a.client_id && a.last_inbound_at) {
      lastInboundByClient.set(a.client_id, a.last_inbound_at);
    }
  }

  // Sort across the three tiers.
  rows.sort((a, b) => {
    const aUnseen = a.client_id ? unseenByClient.get(a.client_id) ?? null : null;
    const bUnseen = b.client_id ? unseenByClient.get(b.client_id) ?? null : null;
    // Tier 1: clients with at least one unread inbound reply,
    // newest-unread-first.
    if (aUnseen && bUnseen) return aUnseen < bUnseen ? 1 : aUnseen > bUnseen ? -1 : 0;
    if (aUnseen) return -1;
    if (bUnseen) return 1;
    // Tier 2: no unread for either — fall back to most-recent
    // inbound regardless of read state.
    const aAny = a.client_id ? lastInboundByClient.get(a.client_id) ?? null : null;
    const bAny = b.client_id ? lastInboundByClient.get(b.client_id) ?? null : null;
    if (aAny && bAny) return aAny < bAny ? 1 : aAny > bAny ? -1 : 0;
    if (aAny) return -1;
    if (bAny) return 1;
    // Tier 3: nothing ever inbound — deterministic alphabetical tail.
    return a.name.localeCompare(b.name);
  });

  // Strip client_id off the wire — ListRow doesn't carry it (it
  // was only needed for the sort) and the consumer is downstream
  // client components that don't need it.
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    sort_order: r.sort_order,
    shared: r.shared,
  }));
}

// React.cache only — dedupes within ONE render. No TTL cache
// because the recency the sidebar surfaces changes on every
// inbound webhook reply, and a stale 60s cache would defeat the
// whole feature. The existing realtime-refresher fires
// router.refresh() on `messages` INSERT events so each render
// pulls a fresh ordering within ~250ms of any new reply.
export const loadLists = cache(fetchLists);

export async function loadListCounts(workspaceId: string): Promise<Map<string, number>> {
  const supabase = await createServerSupabase();
  const { data } = await supabase
    .from("thread_list_items")
    .select("list_id")
    .eq("workspace_id", workspaceId);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const k = row.list_id as string;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// Per-list count of UNSEEN open threads — drives the "N new" pill on each
// client in the sidebar. Keyed by list id. Returns a plain object (not a
// Map) so it serialises across the server→client component boundary.
//
// These lists are client-backed (lists.client_id set), so a list's unseen
// count is just its client's unseen open-thread count.
export async function loadListUnseenCounts(
  workspaceId: string,
): Promise<Record<string, number>> {
  const supabase = await createServerSupabase();
  const { data: lists } = await supabase
    .from("lists")
    .select("id, client_id")
    .eq("workspace_id", workspaceId);
  const clientLists = (lists ?? []).filter(
    (l) => l.client_id,
  ) as Array<{ id: string; client_id: string }>;
  if (clientLists.length === 0) return {};

  // Page past db-max-rows=1000 — see lib/db/paginated-select.ts.
  const threads = await fetchAllRows<{ client_id: string | null }>(({ from, to }) =>
    supabase
      .from("threads")
      .select("client_id")
      .eq("workspace_id", workspaceId)
      .eq("status", "open")
      .eq("seen", false)
      .range(from, to),
  );

  const unseenByClient = new Map<string, number>();
  for (const t of threads) {
    const cid = t.client_id as string | null;
    if (cid) unseenByClient.set(cid, (unseenByClient.get(cid) ?? 0) + 1);
  }

  const counts: Record<string, number> = {};
  for (const l of clientLists) {
    counts[l.id] = unseenByClient.get(l.client_id) ?? 0;
  }
  return counts;
}
