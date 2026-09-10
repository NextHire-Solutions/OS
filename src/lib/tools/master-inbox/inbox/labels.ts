import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import { ttlCache } from "@/lib/cache/ttl";
import type { LabelRow } from "./labels-shared";

export type { LabelRow } from "./labels-shared";

async function fetchLabels(workspaceId: string): Promise<LabelRow[]> {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("labels")
    .select(
      "id, name, color, sentiment, platform, obligation, mirror_to_emailbison, sort_order, is_system",
    )
    .eq("workspace_id", workspaceId)
    .order("sort_order", { ascending: true });

  if (error) {
    console.error("[loadLabels] query failed", error);
    return [];
  }
  return (data ?? []) as LabelRow[];
}

// Two-layer cache: React.cache dedupes within a render, ttlCache dedupes
// across requests for 30s. Labels rarely change (admin actions only) and
// every inbox page in the workspace asks for the same set.
export const loadLabels = cache(ttlCache(fetchLabels, { ttlMs: 30_000 }));
