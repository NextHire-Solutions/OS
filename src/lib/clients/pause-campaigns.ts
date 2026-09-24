import "server-only";

import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { keyOf } from "./roster";

/*
 * Pausing a client's campaigns when they pause or churn.
 *
 * §21 steps 8 and 9 say "every relevant system reflects the paused state" and
 * never say whether campaigns are one of them. They are, by decision: a client
 * marked paused or churned has their campaigns PAUSED, and never deleted.
 *
 * Until now nothing happened at all -- a churned client's campaigns kept
 * running unless somebody stopped them by hand. Measured before this shipped:
 * 49 campaigns platform-wide could still send, and NONE of them belonged to a
 * paused or churned client, so the rule was being followed by hand. This makes
 * it hold on its own; it is not fixing a current leak.
 *
 * ---------------------------------------------------------------------------
 * PAUSE ONLY. THE WORD IS A LITERAL, NOT A VARIABLE.
 *
 * Analytics' action endpoint also accepts `resume` and `archive`. This module
 * sends the string "pause" and nothing else, written inline at the call site so
 * no future refactor can make the action configurable and have a caller pass
 * something destructive. There is no delete action in that endpoint at all,
 * which is one fewer thing to get wrong.
 *
 * Reactivation deliberately does NOT resume. Resuming does not restore a
 * previous state -- on EmailBison it QUEUES the campaign to send -- so a client
 * coming back would start emailing everyone still attached to their campaigns,
 * without anyone choosing to. Bringing campaigns back is a decision a person
 * makes, one campaign at a time, in Analytics.
 *
 * ---------------------------------------------------------------------------
 * ONLY WHAT CAN ACTUALLY SEND
 *
 * PAUSABLE mirrors `canApply("pause", ...)` in
 *   Corofy/Analytics Dashboard/src/lib/campaigns/status.ts
 * and must stay in step with it. Pausing a draft, a completed or an archived
 * campaign is a no-op that EmailBison may reject outright, so those are skipped
 * with a reason rather than sent and counted as failures. The test below is the
 * contract between the two copies.
 *
 * EVERY PORTAL'S CAMPAIGNS. The client's Analytics rows are resolved through
 * its name AND its aliases -- a client working two markets has two Analytics
 * rows, and pausing only the linked one would leave the other market sending.
 */

/** Mirrors Analytics' canApply("pause", status). Keep in step. */
export const PAUSABLE_STATUSES = ["active", "queued", "launching"] as const;

export type CampaignPlatform = "emailbison" | "instantly";

export interface CampaignRow {
  platform: CampaignPlatform;
  id: string;
  name: string;
  /** Already lower-cased and, for Instantly, already turned into a word. */
  status: string;
}

export interface PausePlan {
  /** Campaigns that can still send, and will be paused. */
  pausable: CampaignRow[];
  /** Everything else, each with the reason it was left alone. */
  skipped: { campaign: CampaignRow; reason: string }[];
}

/*
 * Analytics' own integer mapping for Instantly campaign status.
 *
 * Guarded against coercion, which a plain `Number(code)` gets wrong in the most
 * misleading way possible: Number(null), Number("") and Number(false) are all
 * 0, so a NULL status would have been reported as "draft" -- a confident,
 * plausible answer about a campaign whose state we do not actually know.
 * Analytics' own copy takes a `number` and never sees null; this one reads
 * straight from the database, where the column can be null.
 *
 * Anything that is not an integer 0-3 is "error", which is not pausable.
 */
export function instantlyStatusWord(code: unknown): string {
  if (typeof code !== "number" && typeof code !== "string") return "error";
  if (typeof code === "string" && code.trim() === "") return "error";
  const n = Number(code);
  if (!Number.isInteger(n)) return "error";
  return { 0: "draft", 1: "active", 2: "paused", 3: "completed" }[n] ?? "error";
}

/**
 * Which of a client's campaigns to pause.
 *
 * Pure, so the rule is testable without touching a campaign platform.
 */
export function planCampaignPause(campaigns: CampaignRow[]): PausePlan {
  const pausable: CampaignRow[] = [];
  const skipped: PausePlan["skipped"] = [];
  for (const c of campaigns) {
    const status = (c.status ?? "").toLowerCase();
    if ((PAUSABLE_STATUSES as readonly string[]).includes(status)) {
      pausable.push(c);
      continue;
    }
    skipped.push({
      campaign: c,
      reason:
        status === "paused"
          ? "already paused"
          : status === "completed" || status === "archived"
            ? `${status} — it cannot send, and pausing it is a no-op the platform may reject`
            : status === "draft"
              ? "a draft has never sent"
              : `status "${status || "unknown"}" cannot be paused`,
    });
  }
  return { pausable, skipped };
}

export interface PauseResult {
  /** What the plan was, whether or not it was applied. */
  plan: PausePlan;
  /** False for a dry run — nothing was sent. */
  applied: boolean;
  /** Per campaign, because a fan-out genuinely can half-succeed. */
  results: { campaign: CampaignRow; ok: boolean; error?: string }[];
  /** Set when the campaigns could not even be listed. */
  error?: string;
}

/** Every Analytics client row this client is known by — name and aliases. */
async function analyticsRowIdsFor(client: {
  name: string;
  aliases?: string[] | null;
}): Promise<string[]> {
  const db = getAnalyticsSupabase();
  const { data, error } = await db.from("clients").select("id, name").limit(1000);
  if (error) throw new Error(error.message);
  const keys = new Set(
    [client.name, ...(client.aliases ?? [])]
      .map((n) => keyOf((n ?? "").trim()))
      .filter(Boolean),
  );
  const ids: string[] = [];
  for (const row of (data ?? []) as { id: string; name: string }[]) {
    const k = keyOf((row.name ?? "").trim());
    if (k && keys.has(k) && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

async function campaignsFor(clientIds: string[]): Promise<CampaignRow[]> {
  if (clientIds.length === 0) return [];
  const db = getAnalyticsSupabase();
  const out: CampaignRow[] = [];

  const [bisonMap, instantlyMap] = await Promise.all([
    db.from("campaign_clients").select("campaign_id, client_id").in("client_id", clientIds),
    db
      .from("instantly_campaign_clients")
      .select("campaign_id, client_id, excluded")
      .in("client_id", clientIds),
  ]);
  if (bisonMap.error) throw new Error(bisonMap.error.message);
  if (instantlyMap.error) throw new Error(instantlyMap.error.message);

  const bisonIds = (bisonMap.data ?? []).map((r) => String(r.campaign_id));
  // An excluded mapping is a campaign somebody deliberately detached from this
  // client. Pausing it would act on a client's behalf over a link they removed.
  const instantlyIds = (instantlyMap.data ?? [])
    .filter((r) => !(r as { excluded?: boolean }).excluded)
    .map((r) => String(r.campaign_id));

  if (bisonIds.length) {
    const { data, error } = await db
      .from("campaigns")
      .select("id, name, status")
      .in("id", bisonIds);
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as { id: unknown; name: string; status: unknown }[]) {
      out.push({
        platform: "emailbison",
        id: String(c.id),
        name: c.name ?? "",
        status: String(c.status ?? "").toLowerCase(),
      });
    }
  }
  if (instantlyIds.length) {
    const { data, error } = await db
      .from("instantly_campaigns")
      .select("id, name, status")
      .in("id", instantlyIds);
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as { id: unknown; name: string; status: unknown }[]) {
      out.push({
        platform: "instantly",
        id: String(c.id),
        name: c.name ?? "",
        status: instantlyStatusWord(c.status),
      });
    }
  }
  return out;
}

/**
 * Pauses everything this client has that can still send.
 *
 * `apply: false` plans without sending anything, which is how this was verified
 * against production before it was ever allowed to act.
 */
export async function pauseCampaignsForClient(
  client: { name: string; aliases?: string[] | null },
  { apply }: { apply: boolean },
): Promise<PauseResult> {
  const none: PauseResult = {
    plan: { pausable: [], skipped: [] },
    applied: false,
    results: [],
  };

  let plan: PausePlan;
  try {
    const ids = await analyticsRowIdsFor(client);
    plan = planCampaignPause(await campaignsFor(ids));
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : "could not list campaigns" };
  }

  if (!apply || plan.pausable.length === 0) return { ...none, plan };

  const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
  if (!secret) return { ...none, plan, error: "ANALYTICS_AUTH_SECRET not set" };

  try {
    const token = await mintAnalyticsSession(
      secret,
      optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com",
    );
    const res = await fetch(`${baseUrlEnv("ANALYTICS_URL")}/api/campaigns/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `bsa_session=${token}` },
      body: JSON.stringify({
        // The literal. Never a variable, never from an argument.
        action: "pause",
        targets: plan.pausable.map((c) => ({ platform: c.platform, id: c.id })),
        confirm: true,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => null)) as {
      results?: { ok?: boolean; error?: string }[];
      error?: string;
    } | null;
    // 207 is the honest partial: some paused, some refused.
    if (!res.ok && res.status !== 207) {
      return { ...none, plan, error: body?.error ?? `HTTP ${res.status}` };
    }
    const results = plan.pausable.map((campaign, i) => {
      const r = body?.results?.[i];
      return { campaign, ok: r?.ok !== false, error: r?.error };
    });
    return { plan, applied: true, results };
  } catch (e) {
    return { ...none, plan, error: e instanceof Error ? e.message : "pause request failed" };
  }
}
