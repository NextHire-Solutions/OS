import "server-only";

import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";

import { readOnly } from "./read-only.ts";
import { describeDbError } from "./describe-error.ts";

/*
 * Onboarding, and the sending infrastructure.
 *
 * Both are estate-wide questions rather than per-client ones, which changes
 * the hazard: there is no client id to scope a read, so every query here runs
 * against the whole table and the 1,000-row cap is one forgotten `count` away.
 * sender_emails alone is 1,805 rows — a tally of a plain read would report 55%
 * of the fleet as the whole of it.
 */

const db = {
  analytics: () => readOnly(getAnalyticsSupabase()),
  agentSearch: () => readOnly(getAgentSearchSupabase()),
};

async function countWhere(
  build: () => { then: unknown },
): Promise<number | null> {
  try {
    const { count, error } = (await build()) as unknown as { count: number | null; error: unknown };
    return error ? null : count ?? 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// onboarding_pipeline
// ---------------------------------------------------------------------------

/**
 * Who is mid-onboarding, and who is stuck.
 *
 * `orch_clients.status` is the pipeline: new → assigned → campaign_launched,
 * with paused off to one side. "Stuck" is not a status — it is a client that
 * has sat in a pre-launch status for a while, which is why the age of the row
 * is reported next to it rather than a flag nobody set.
 */
export async function onboardingPipelineTool(options: { stalledDays?: number } = {}) {
  const stalledDays = Math.min(Math.max(options.stalledDays ?? 14, 1), 180);
  const as = db.agentSearch();

  const { data, error } = await as
    .from("orch_clients")
    .select("client_name, status, brand, office_name, mls, location, created_at")
    .limit(1000);
  if (error) return { error: `Onboarding could not be read: ${describeDbError(error)}` };

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const now = Date.now();

  const byStatus: Record<string, number> = {};
  const stalled: Array<{ client: string; status: string; daysWaiting: number }> = [];

  for (const r of rows) {
    const status = String(r.status ?? "unknown");
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    // Launched clients are done, and paused ones are waiting on purpose.
    if (status === "campaign_launched" || status === "paused") continue;
    const created = r.created_at ? new Date(String(r.created_at)).getTime() : null;
    if (!created) continue;
    const days = Math.floor((now - created) / 86_400_000);
    if (days >= stalledDays) {
      stalled.push({ client: String(r.client_name ?? ""), status, daysWaiting: days });
    }
  }

  stalled.sort((a, b) => b.daysWaiting - a.daysWaiting);

  return {
    total: rows.length,
    byStatus,
    stalledThresholdDays: stalledDays,
    stalled: stalled.slice(0, 25),
    note:
      "Statuses run new → assigned → campaign_launched. 'Stalled' means a client has sat in a " +
      "pre-launch status for longer than the threshold; launched and paused clients are excluded.",
  };
}

// ---------------------------------------------------------------------------
// infrastructure_health
// ---------------------------------------------------------------------------

/**
 * The sending fleet: how many mailboxes can actually send, and how much.
 *
 * COUNTED, NOT TALLIED. There are 1,805 EmailBison senders, so reading them
 * and grouping in JavaScript would silently describe the first 1,000 — the
 * same failure that made a pool of 534 read as 269 on the inbox-tags screen.
 * Each status is its own database count.
 *
 * Daily capacity is the one figure that does need the rows, because it sums a
 * column. It is paged, and says so if it ever stops early.
 */
export async function infrastructureHealthTool() {
  const an = db.analytics();

  const statuses = ["Connected", "Not connected", "Failed"];
  const emailBison: Record<string, number | null> = {};
  for (const status of statuses) {
    emailBison[status] = await countWhere(() =>
      an.from("sender_emails").select("id", { count: "exact", head: true }).eq("status", status),
    );
  }
  const ebTotal = await countWhere(() =>
    an.from("sender_emails").select("id", { count: "exact", head: true }),
  );

  const instantlyTotal = await countWhere(() =>
    an.from("instantly_accounts").select("email", { count: "exact", head: true }),
  );

  /*
   * Instantly's account status is an integer whose meaning is not documented
   * anywhere we control, and every one of the 536 accounts currently reads 2.
   *
   * The first version filtered on `status = 1` and called the result "active",
   * which reported 0 of 536 active — a precise, alarming and entirely invented
   * figure. Rather than guess which integer means healthy, the codes are
   * reported as they are found. An unexplained "2: 536" is honest; a confident
   * "0 active" is not.
   */
  const instantlyByStatus: Record<string, number> = {};
  {
    const { data } = await an.from("instantly_accounts").select("status").limit(1000);
    for (const row of (data ?? []) as Array<{ status: number | null }>) {
      const key = String(row.status ?? "unknown");
      instantlyByStatus[key] = (instantlyByStatus[key] ?? 0) + 1;
    }
  }

  // Daily capacity of the CONNECTED EmailBison fleet, paged so 1,805 rows are
  // all seen. Three pages today; the cap is generous and reports truncation.
  let capacity = 0;
  let counted = 0;
  let truncated = false;
  for (let page = 0; page < 12; page++) {
    const from = page * 1000;
    const { data, error } = await an
      .from("sender_emails")
      .select("daily_limit")
      .eq("status", "Connected")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) break;
    const rows = (data ?? []) as Array<{ daily_limit: number | null }>;
    for (const r of rows) capacity += r.daily_limit ?? 0;
    counted += rows.length;
    if (rows.length < 1000) break;
    if (page === 11) truncated = true;
  }

  return {
    emailBison: { total: ebTotal, byStatus: emailBison },
    instantly: { total: instantlyTotal, byStatusCode: instantlyByStatus },
    dailySendCapacity: { emails: capacity, fromConnectedInboxes: counted, ...(truncated ? { truncated: true } : {}) },
    note:
      "Capacity is the sum of the daily limits on CONNECTED EmailBison inboxes — what the fleet could " +
      "send in a day, not what it did send. Disconnected and failed inboxes contribute nothing. " +
      "Instantly reports account state as an undocumented integer, so the codes are given raw rather " +
      "than translated into 'active' — do not read a code as healthy or unhealthy without checking.",
  };
}
