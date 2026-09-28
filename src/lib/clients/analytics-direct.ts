import "server-only";

import { getAnalyticsSupabase, analyticsTeamId } from "@/lib/tools/analytics/supabase";
import { applyCampaignAction, type ActionResult } from "@/lib/tools/analytics/campaigns/actions.ts";

import { insertRow, updateRow, type ClientPatch, type NewClient } from "./analytics-rows";

/*
 * ANALYTICS, WRITTEN BY THE OS ITSELF — no call to the standalone app.
 *
 * Status changes, edits, deletes, onboarding and campaign pauses used to sign
 * in to the standalone Analytics app (a minted `bsa_session` cookie) and call
 * its HTTP API. That app is being switched off; every one of those actions
 * would then have failed. Each route it called was a plain write to Analytics'
 * own database, which the OS already reaches (its sync jobs run here), so the
 * same writes happen here directly:
 *
 *   POST   /api/clients            → createAnalyticsClient
 *   PATCH  /api/clients/:id        → updateAnalyticsClient
 *   DELETE /api/clients/:id        → deleteAnalyticsClient
 *   POST   /api/campaigns/actions  → pauseCampaigns (the same applyCampaignAction,
 *                                    identical to the tool's apart from imports)
 *
 * The values written are the tool's own (analytics-rows.ts, tested). Its
 * database triggers still fire — they live in the database, not the app — so
 * `status` and `active` stay in step exactly as before.
 */

export async function createAnalyticsClient(
  input: NewClient,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const row = insertRow(input, analyticsTeamId());
  if (!row) return { status: 400, body: { error: "Invalid client" } };
  const { data, error } = await getAnalyticsSupabase().from("clients").insert(row).select().single();
  if (error) {
    const conflict = error.message.includes("duplicate") || error.code === "23505";
    return {
      status: conflict ? 409 : 500,
      body: { error: conflict ? "A client with that name already exists" : error.message },
    };
  }
  return { status: 201, body: { client: data } };
}

export async function updateAnalyticsClient(id: string, patch: ClientPatch): Promise<Record<string, unknown>> {
  const values = updateRow(patch);
  if (!values) throw new Error("Invalid update");
  const { data, error } = await getAnalyticsSupabase().from("clients").update(values).eq("id", id).select().single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

/**
 * campaign_clients.client_id is ON DELETE SET NULL, so the campaigns fall back
 * to Unassigned rather than disappearing — no campaign data is deleted.
 */
export async function deleteAnalyticsClient(id: string): Promise<void> {
  const { error } = await getAnalyticsSupabase().from("clients").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Pause, and only pause — the action is a literal here, never an argument. */
export async function pauseCampaigns(
  targets: { platform: "emailbison" | "instantly"; id: string }[],
  actor: string,
): Promise<ActionResult[]> {
  const { results } = await applyCampaignAction("pause", targets, actor, analyticsTeamId());
  return results;
}
