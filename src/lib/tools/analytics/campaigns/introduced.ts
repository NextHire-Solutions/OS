import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";

import { introducedFor, type IntroRow, type IntroducedSet } from "./introduced-match.ts";

/*
 * A campaign's introduced leads, read LIVE from Master Inbox (8 Oct).
 *
 * The inbox records an introduction in its portal pipeline at the moment the
 * Introduction label is applied (v_pipeline_outcomes, event "introduction").
 * Analytics only receives a copy hourly, so reading the inbox here is what makes
 * the Leads tab's "Introduced" status instant. Both databases are read-only from
 * here; the answer is handed to the Analytics functions (migration 095).
 *
 * Cached for 5 seconds only — enough for the rows and the chip counts of one
 * page view to share a lookup, short enough that a new introduction shows on
 * the next view. No stale serving.
 */

const PAGE = 1000;
const MAX_PAGES = 20;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Every row, a page at a time — the API returns at most 1,000 per request. */
async function allRows<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const INTRO_COLS = "email, emailbison_lead_id, campaign_id, client_id, voided";

async function load(platform: "emailbison" | "instantly", campaignId: string | number): Promise<IntroducedSet> {
  const mi = createAdminSupabase();
  const id = String(campaignId);
  const [mine, threads, unknown] = await Promise.all([
    // Introductions recorded for this campaign.
    allRows<IntroRow>((a, b) => mi.from("v_pipeline_outcomes").select(INTRO_COLS)
      .eq("event_type", "introduction").eq("voided", false).eq("campaign_id", id).range(a, b)),
    // The campaign's client(s): whoever its conversations belong to.
    allRows<{ client_id: string | null }>((a, b) => mi.from("threads").select("client_id")
      .eq("campaign_id", id).not("client_id", "is", null).range(a, b)),
    mi.from("clients").select("id").ilike("name", "unknown"),
  ]);
  if (unknown.error) throw new Error(unknown.error.message);
  const unknownIds = new Set(((unknown.data ?? []) as Array<{ id: string }>).map((c) => c.id));
  const clientIds = [...new Set([...threads.map((t) => t.client_id), ...mine.map((r) => r.client_id)])]
    .filter((c): c is string => !!c && !unknownIds.has(c));

  // Introductions for those clients with no campaign recorded (introducedFor
  // keeps only those, and drops any tied to a different campaign).
  const forClients = clientIds.length
    ? await allRows<IntroRow>((a, b) => mi.from("v_pipeline_outcomes").select(INTRO_COLS)
        .eq("event_type", "introduction").eq("voided", false).in("client_id", clientIds).range(a, b))
    : [];

  return introducedFor([...mine, ...forClients], id, clientIds, platform);
}

export const campaignIntroductions = ttlCache(load, {
  ttlMs: 5_000,
  key: (platform, campaignId) => `${platform}:${String(campaignId).toLowerCase()}`,
  shared: "analytics-campaign-introductions",
});
