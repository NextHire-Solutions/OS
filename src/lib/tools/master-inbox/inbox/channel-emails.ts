import { cache } from "react";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/cache/ttl";

// Map of channel_id → the most recent outbound sender address.
//
// EmailBison channels store only a friendly display_name ("Nicole
// Collins") — the actual sending address lives on the messages. The
// SenderPicker needs the address to disambiguate channels that share a
// display_name. We derive it from the most recent outbound messages.
//
// WHY THIS IS ITS OWN CACHED LOADER: this used to run inline in the
// thread-detail page, SERIALLY, after the "ready to render" mark, on the
// critical path of every single thread open — invisible to the per-loader
// timing. In production it took ~7s (NOT the ~0.5s it takes in isolation)
// because the workspace had 402 EmailBison channels: the old
// `.in("channel_id", <402 uuids>)` built an ~18 KB request URL, over the
// PostgREST/Node 16 KB header cap, which undici handles pathologically
// in-region. So this loader now:
//   1. DROPS the giant channel_id IN — it simply reads the workspace's
//      most-recent outbound messages and keys the map by whatever
//      channels appear (small URL, fast, no header-cap risk). Extra
//      non-EmailBison channels in the map are harmless; callers only look
//      up the EmailBison ids they care about. Channels with no outbound
//      in the recent window fall back to display_name in the picker — an
//      acceptable edge for a compose-time nicety.
//   2. runs INSIDE the page's Promise.all (parallel with loadThreads etc.),
//      not serially after it, and
//   3. is ttl-cached per workspace for 5 min (the map is workspace-stable),
//      so router.refresh() and rapid opens don't re-run it.
async function fetchChannelEmailMap(
  workspaceId: string,
): Promise<Record<string, string>> {
  const { data } = await createAdminSupabase()
    .from("messages")
    .select("channel_id, sender")
    .eq("workspace_id", workspaceId)
    .eq("direction", "outbound")
    .not("sender", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1000);

  const map: Record<string, string> = {};
  for (const m of (data ?? []) as Array<{
    channel_id: string;
    sender: string | null;
  }>) {
    if (!m.sender || !m.channel_id) continue;
    if (!(m.channel_id in map)) map[m.channel_id] = m.sender;
  }
  return map;
}

// cache() dedupes within a render; ttlCache() holds the result for 5 min
// across renders/users on the same workspace.
export const loadChannelEmailMap = cache(
  ttlCache(fetchChannelEmailMap, { ttlMs: 5 * 60_000, key: (ws) => ws }),
);
