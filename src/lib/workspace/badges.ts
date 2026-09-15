import "server-only";

import { cache } from "react";

import { ttlCache } from "@/lib/cache/ttl";
import { getMasterInboxSupabase, workspaceId } from "@/lib/tools/master-inbox/supabase";
import { loadViewBySlug, loadViewCounts } from "@/lib/tools/master-inbox/inbox/views";

/*
 * The counts on the rail's leaves.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * `nav.ts` has declared `badgeKey: "inbox-unread"` and `badgeKey: "reminders"`
 * from the beginning, `Rail` renders a `.pill` whenever a count arrives, and
 * `Workspace` threads a `badges` prop the whole way down to it. Nothing ever
 * passed one. The path was wired end to end and fed nothing, so the design's
 * "Master Inbox 37" never appeared — and because an absent badge looks exactly
 * like a zero, nothing ever looked broken enough to ask why.
 *
 * ---------------------------------------------------------------------------
 * WHY IT BORROWS THE INBOX'S OWN COUNT INSTEAD OF ASKING ITSELF
 *
 * The first version of this counted `threads where seen = false` directly. It
 * returned 61 while the All Email tab, three centimetres to the right on the
 * same screen, said "1 new" — because the tab counts what that VIEW shows and
 * a bare `seen = false` also sweeps up archived, trashed and filtered-out
 * threads. Two numbers for one idea, both defensible, both on screen at once.
 *
 * So it asks `loadViewCounts`, which is what the tab bar itself renders from:
 * the `inbox_view_counts` aggregate (migration 0058), one server-side call,
 * already `cache`d per request. The badge and the tab now cannot disagree,
 * because there is only one number — and if the definition of "new" ever
 * changes, it changes in one place.
 *
 * Reminders is still a direct count: nothing else computes it, and `head: true`
 * with `count: "exact"` is answered from the index without returning a body.
 * Never select ids and take `.length` here — PostgREST truncates at 1000 rows,
 * which is how `weekly_metrics` was once read as 0 when the real answer was
 * 1,840.
 *
 * Sixty seconds of TTL on top. A badge a minute stale is fine; recomputing this
 * on every render of every route in the workspace is not.
 */

/*
 * A type alias, not an interface, and that is load-bearing: `Rail` takes
 * `Partial<Record<string, number>>`, and TypeScript gives an implicit index
 * signature to type aliases but never to interfaces — so the interface form
 * failed to assign, with a message that reads like a missing property.
 */
export type RailBadges = Partial<Record<"inbox-unread" | "reminders", number>>;

async function fetchBadges(): Promise<RailBadges> {
  try {
    const ws = await workspaceId();

    const [counts, allEmail, reminders] = await Promise.all([
      loadViewCounts(ws),
      /*
       * `loadViewCounts` keys its record by VIEW ID, not by URL slug — so
       * `counts["all-email"]` was simply undefined and the badge silently
       * never rendered. Resolving the slug to its view first is the same hop
       * the inbox itself makes, and both calls are `cache`d per request, so
       * this adds no round trip.
       */
      loadViewBySlug(ws, "all-email"),
      getMasterInboxSupabase()
        .from("reminders")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", ws)
        .eq("status", "pending"),
    ]);

    const out: RailBadges = {};
    const unseen = allEmail ? counts[allEmail.id]?.unseen : undefined;
    // Zeroes are left out rather than sent as 0. `Rail` already hides counts
    // that are not above zero, and carrying an explicit 0 only invites a
    // future `?? 0` somewhere that renders it.
    if (typeof unseen === "number" && unseen > 0) out["inbox-unread"] = unseen;
    if (!reminders.error && typeof reminders.count === "number" && reminders.count > 0) {
      out.reminders = reminders.count;
    }
    return out;
  } catch {
    /*
     * A badge is decoration. If the counts cannot be had — no request scope, a
     * database blip, a schema change — the rail renders without numbers, which
     * is precisely how it rendered before this file existed. It must never be
     * the reason a page fails to load.
     */
    return {};
  }
}

export const loadRailBadges = cache(ttlCache(fetchBadges, { ttlMs: 60_000 }));
