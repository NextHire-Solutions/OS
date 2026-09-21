import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";

import { findClient } from "./identity.ts";
import { readOnly } from "./read-only.ts";
import { describeDbError } from "./describe-error.ts";

/*
 * The last four surfaces: outcomes, MLS coverage, and reminders.
 *
 * These were the things the assistant could see existed and could not read —
 * and while it could not read them it told people their business did not
 * track them. Closing that is as much the point as the data.
 */

const db = {
  masterInbox: () => readOnly(createAdminSupabase()),
  analytics: () => readOnly(getAnalyticsSupabase()),
  agentSearch: () => readOnly(getAgentSearchSupabase()),
};

// ---------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------

/*
 * The stages an introduced agent moves through, in the order they happen.
 * Fixed rather than derived from the data so a funnel always reads top to
 * bottom, and a stage with nothing in it still appears as a zero — an absent
 * row and a zero mean different things to someone reading a funnel.
 */
const OUTCOME_ORDER = [
  "introduction",
  "phone_screen_scheduled",
  "phone_screen",
  "interview_scheduled",
  "interview",
  "hired",
  "keep_warm",
  "no_show",
  "we_they_rejected",
] as const;

/**
 * What actually happened to the people we introduced.
 *
 * VOIDED EVENTS ARE EXCLUDED. 42 of the first thousand rows are voided —
 * corrections, not history — and counting them would inflate every stage.
 *
 * Counted per stage in the database rather than by reading and tallying:
 * there are 3,177 events today and the cap would clip a year-long window
 * without saying so.
 */
export async function outcomesTool(options: { days?: number; client?: string } = {}) {
  const days = Math.min(Math.max(options.days ?? 90, 1), 730);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const an = db.analytics();

  let clientName: string | null = null;
  let resolvedClientId: string | null = null;
  if (options.client) {
    const { match, candidates } = await findClient(options.client);
    if (!match) {
      return {
        error: candidates.length ? `"${options.client}" matches several clients. Ask which one.` : `No client named "${options.client}".`,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      };
    }
    clientName = match.name;
    if (!match.analyticsClientId) {
      return { client: match.name, notLinked: "analytics", note: "Not linked to Campaign Analytics, so its outcomes cannot be read." };
    }
    resolvedClientId = match.analyticsClientId;
  }

  const stages: Array<{ stage: string; count: number | null }> = [];
  for (const stage of OUTCOME_ORDER) {
    try {
      let q = an
        .from("outcome_events")
        .select("id", { count: "exact", head: true })
        .eq("event_type", stage)
        .eq("voided", false)
        .gte("occurred_at", since);
      if (resolvedClientId) q = q.eq("resolved_client_id", resolvedClientId);
      const { count, error } = (await q) as unknown as { count: number | null; error: unknown };
      stages.push({ stage, count: error ? null : count ?? 0 });
    } catch {
      stages.push({ stage, count: null });
    }
  }

  const intro = stages.find((s) => s.stage === "introduction")?.count ?? 0;
  const hired = stages.find((s) => s.stage === "hired")?.count ?? 0;

  return {
    client: clientName,
    periodDays: days,
    since,
    stages,
    hireRate: intro && intro > 0 ? Number((hired / intro).toFixed(4)) : null,
    note:
      "Voided events are excluded — they are corrections, not history. `hireRate` is hires divided by " +
      "introductions in the same window, so a hire from an older introduction flatters it slightly.",
  };
}

// ---------------------------------------------------------------------------
// mls_coverage
// ---------------------------------------------------------------------------

/**
 * Which MLS areas each account is monitoring — the courted-accounts view.
 *
 * `mls_monitor_state` is one row per sending account, holding the areas it
 * watches and how many agents each holds. Nine rows, so it is returned whole
 * rather than paged.
 */
export async function mlsCoverageTool() {
  const as = db.agentSearch();
  const [{ data: monitor }, { data: refresh }] = await Promise.all([
    as.from("mls_monitor_state").select("email, mls, total, scanned_at").limit(100),
    as.from("refresh_state").select("email, last_refreshed_at, last_status, last_message").limit(100),
  ]);

  const refreshByEmail = new Map(
    ((refresh ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.email), r]),
  );

  const accounts = ((monitor ?? []) as Array<Record<string, unknown>>).map((m) => {
    const areas = Array.isArray(m.mls) ? (m.mls as Array<Record<string, unknown>>) : [];
    const r = refreshByEmail.get(String(m.email));
    return {
      account: String(m.email ?? ""),
      areas: areas.map((a) => ({
        code: String(a.code ?? ""),
        name: String(a.name ?? ""),
        agents: (a.count as number) ?? null,
      })),
      totalAgents: (m.total as number) ?? null,
      scannedAt: (m.scanned_at as string) ?? null,
      lastRefreshedAt: (r?.last_refreshed_at as string) ?? null,
      lastStatus: (r?.last_status as string) ?? null,
      lastMessage: (r?.last_message as string) ?? null,
    };
  });

  return {
    accounts,
    note:
      "One row per monitored account, with the MLS areas it watches and the agent count in each. " +
      "`lastStatus` is the most recent refresh of that account's monitor.",
  };
}

// ---------------------------------------------------------------------------
// reminders
// ---------------------------------------------------------------------------

/**
 * Follow-ups someone set on a thread.
 *
 * Overdue is separated from upcoming rather than left to be worked out from
 * timestamps: the only reason to ask about reminders is to find what has been
 * missed.
 */
export async function remindersTool(options: { includeDone?: boolean } = {}) {
  const mi = db.masterInbox();
  /*
   * `status` is an ENUM and its values are pending / fired / dismissed — not
   * "done". Filtering on `neq.done` is a 400, not an empty result, which this
   * function reported as "reminders could not be read". The same shape of bug
   * as threads.status earlier in this build: a plausible English word that the
   * database has never heard of.
   *
   * Dismissed is the settled state, so that is what gets filtered out.
   */
  let q = mi
    .from("reminders")
    .select("thread_id, remind_at, note, status, created_at")
    .order("remind_at", { ascending: true })
    .limit(100);
  if (!options.includeDone) q = q.neq("status", "dismissed");

  const { data, error } = await q;
  if (error) {
    return { error: `Reminders could not be read: ${describeDbError(error)}` };
  }

  const now = Date.now();
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const at = r.remind_at ? new Date(String(r.remind_at)).getTime() : null;
    return {
      threadId: String(r.thread_id ?? ""),
      remindAt: (r.remind_at as string) ?? null,
      note: String(r.note ?? ""),
      status: String(r.status ?? ""),
      overdue: at != null && at < now,
      daysOverdue: at != null && at < now ? Math.floor((now - at) / 86_400_000) : null,
    };
  });

  return {
    overdue: rows.filter((r) => r.overdue),
    upcoming: rows.filter((r) => !r.overdue),
    total: rows.length,
  };
}
