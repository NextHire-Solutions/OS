import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";

import { findClient, resolveAll, type ProductKey, type ResolvedClient } from "./identity.ts";
import { readOnly } from "./read-only.ts";

/*
 * What the assistant is allowed to ask the estate.
 *
 * ---------------------------------------------------------------------------
 * WHY TOOLS AND NOT SQL
 *
 * The obvious build is `run_sql` over the 145 tables and 128 functions these
 * four products hold. It would demo well and be wrong in ways nobody catches:
 * the model would invent joins, miss that Analytics links to Master Inbox by
 * portal_client_id rather than by name, and — the one that has already bitten
 * this estate three times — silently stop at PostgREST's 1,000-row cap and
 * report the truncation as the answer.
 *
 * So the model never writes a query. It picks a tool. Each tool below owns one
 * question, with the correct joins and the counting done in the database, and
 * is the only place that knowledge lives.
 *
 * ---------------------------------------------------------------------------
 * COUNTS ARE COUNTED, NEVER MEASURED BY LENGTH
 *
 * `count: "exact", head: true` asks Postgres for the number and transfers no
 * rows. Every `.length` on a fetched array in this file would be a lie above
 * 1,000 — that is precisely how the Prospects tile came to over-report and how
 * the Client Health total once read 0. There is no `.length` count here.
 *
 * ---------------------------------------------------------------------------
 * A GAP IS REPORTED, NOT ZEROED
 *
 * Every figure that could not be fetched comes back `null` with the product
 * named in `missing`, never 0. "No scrapes for Howe Realty" and "Howe Realty
 * is not linked to Agent Search" are different answers, and the assistant is
 * told which one it has.
 */

const db = {
  masterInbox: () => readOnly(createAdminSupabase()),
  analytics: () => readOnly(getAnalyticsSupabase()),
  clientHealth: () => readOnly(getClientHealthSupabase()),
  agentSearch: () => readOnly(getAgentSearchSupabase()),
};

/** A number the database counted, or null when the product was unreachable. */
type Counted = number | null;

async function countOf(
  build: () => { then: unknown },
): Promise<Counted> {
  try {
    const { count, error } = (await build()) as unknown as { count: number | null; error: unknown };
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// find_client
// ---------------------------------------------------------------------------

export interface FindClientResult {
  match: { id: string; name: string; missing: ProductKey[] } | null;
  candidates: Array<{ id: string; name: string }>;
  note?: string;
}

/**
 * Resolve however the person typed a client name.
 *
 * Returns candidates rather than a guess when the name is ambiguous. "rise"
 * really is three different companies on this estate, and answering for the
 * wrong one puts another client's numbers under this client's name.
 */
export async function findClientTool(query: string): Promise<FindClientResult> {
  const { match, candidates } = await findClient(query);
  if (match) {
    return {
      match: { id: match.id, name: match.name, missing: match.missing },
      candidates: [],
      note: match.missing.length
        ? `Not linked to ${match.missing.join(" or ")} — figures from those products are unavailable for this client, which is not the same as zero.`
        : undefined,
    };
  }
  return {
    match: null,
    candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    note: candidates.length
      ? "Several clients match. Ask which one before answering — do not pick."
      : "No client matches that name.",
  };
}

// ---------------------------------------------------------------------------
// client_overview
// ---------------------------------------------------------------------------

export interface ClientOverview {
  client: { id: string; name: string };
  missing: ProductKey[];
  inbox: {
    threads: Counted;
    openThreads: Counted;
    /*
     * Rows in the client's portal pipeline, by stage.
     *
     * NOT called "introductions", deliberately. Client Health already reports
     * an intro count (`total_intros_corofy`) and the two do not agree — Keyes
     * has 125 pipeline entries against 88 intros there, because entries arrive
     * by other routes too. Publishing a second number under the same word is
     * how an assistant loses the right to be believed, so this one is named
     * for what it counts and the intro figures stay Client Health's.
     */
    pipelineEntries: Counted;
    pipelineByStage: Record<string, number> | null;
  };
  campaigns: {
    total: Counted;
    active: Counted;
    emailsSent: Counted;
    replies: Counted;
    replyRate: number | null;
  };
  health: {
    plan: string | null;
    paused: boolean | null;
    weeklyTarget: number | null;
    monthlyTarget: number | null;
    introsThisMonth: number | null;
    totalIntros: number | null;
    stagnantIntros: number | null;
    lastLeadActivityAt: string | null;
  } | null;
  scraping: { agents: Counted; lastScrapeAt: string | null } | null;
}

export async function clientOverviewTool(clientQuery: string): Promise<
  ClientOverview | { error: string; candidates?: Array<{ id: string; name: string }> }
> {
  const { match, candidates } = await findClient(clientQuery);
  if (!match) {
    return {
      error: candidates.length
        ? `"${clientQuery}" matches several clients. Ask which one.`
        : `No client named "${clientQuery}".`,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    };
  }

  const [inbox, campaigns, health, scraping] = await Promise.all([
    inboxFor(match),
    campaignsFor(match),
    healthFor(match),
    scrapingFor(match),
  ]);

  return {
    client: { id: match.id, name: match.name },
    missing: match.missing,
    inbox,
    campaigns,
    health,
    scraping,
  };
}

async function inboxFor(client: ResolvedClient): Promise<ClientOverview["inbox"]> {
  const mi = db.masterInbox();
  const [threads, openThreads, pipeline] = await Promise.all([
    countOf(() => mi.from("threads").select("id", { count: "exact", head: true }).eq("client_id", client.id)),
    /*
     * `status` is an ENUM, and "closed" is not one of its values — asking for
     * `neq.closed` is a 400, which this function would have reported as null,
     * i.e. as "Master Inbox unreachable". Open is asked for by name instead.
     */
    countOf(() =>
      mi.from("threads").select("id", { count: "exact", head: true })
        .eq("client_id", client.id).eq("status", "open"),
    ),
    /*
     * The portal pipeline, straight off client_id.
     *
     * The first attempt counted Introduction label assignments, which meant
     * fetching this client's thread ids and passing them to .in() — 1,293 uuids
     * on Keyes alone, a 37KB URL, refused. There is no foreign key between
     * label_assignments and threads for PostgREST to embed either. This table
     * carries client_id directly, so neither problem exists.
     */
    (async (): Promise<{ total: Counted; byStage: Record<string, number> | null }> => {
      try {
        const total = await countOf(() =>
          mi.from("client_pipeline_entries").select("id", { count: "exact", head: true })
            .eq("client_id", client.id),
        );
        const { data } = await mi
          .from("client_pipeline_entries").select("stage").eq("client_id", client.id).limit(1000);
        const byStage: Record<string, number> = {};
        for (const row of (data ?? []) as Array<{ stage: string | null }>) {
          const key = row.stage ?? "unknown";
          byStage[key] = (byStage[key] ?? 0) + 1;
        }
        /*
         * The breakdown reads at most 1,000 rows, so it is only published when
         * the true total fits inside that. A breakdown that silently describes
         * the first 1,000 of 1,500 is the exact failure that made the Prospects
         * tile wrong; better to give the total alone than a partial shape.
         */
        return { total, byStage: total != null && total <= 1000 ? byStage : null };
      } catch {
        return { total: null, byStage: null };
      }
    })(),
  ]);
  return {
    threads,
    openThreads,
    pipelineEntries: pipeline.total,
    pipelineByStage: pipeline.byStage,
  };
}

async function campaignsFor(client: ResolvedClient): Promise<ClientOverview["campaigns"]> {
  const empty = { total: null, active: null, emailsSent: null, replies: null, replyRate: null };
  if (!client.analyticsClientId) return empty;
  try {
    const an = db.analytics();
    /*
     * Both platforms, from their two link tables, then the unified view for the
     * numbers. `excluded` rows are deliberate exclusions a person made and must
     * not be counted as this client's campaigns.
     */
    const [eb, inst] = await Promise.all([
      an.from("campaign_clients").select("campaign_id")
        .eq("client_id", client.analyticsClientId).eq("excluded", false),
      an.from("instantly_campaign_clients").select("campaign_id")
        .eq("client_id", client.analyticsClientId).eq("excluded", false),
    ]);
    const ids = [
      ...((eb.data ?? []) as Array<{ campaign_id: string | number }>).map((r) => String(r.campaign_id)),
      ...((inst.data ?? []) as Array<{ campaign_id: string | number }>).map((r) => String(r.campaign_id)),
    ];
    if (!ids.length) return { total: 0, active: 0, emailsSent: 0, replies: 0, replyRate: null };

    const { data: rows } = await an
      .from("campaigns_unified")
      .select("id, status, lifetime_emails_sent, lifetime_unique_replies")
      .in("id", ids);

    const list = (rows ?? []) as Array<{
      status: string | null;
      lifetime_emails_sent: number | null;
      lifetime_unique_replies: number | null;
    }>;
    const sent = list.reduce((n, r) => n + (r.lifetime_emails_sent ?? 0), 0);
    const replies = list.reduce((n, r) => n + (r.lifetime_unique_replies ?? 0), 0);
    return {
      total: ids.length,
      active: list.filter((r) => String(r.status ?? "").toLowerCase() === "active").length,
      emailsSent: sent,
      replies,
      replyRate: sent > 0 ? Number((replies / sent).toFixed(4)) : null,
    };
  } catch {
    return empty;
  }
}

async function healthFor(client: ResolvedClient): Promise<ClientOverview["health"]> {
  if (!client.clientHealthId) return null;
  try {
    const { data } = await db.clientHealth()
      .from("clients")
      .select(
        "plan, client_paused, weekly_target, monthly_target, intros_this_month, total_intros_corofy, stagnant_intros_count, last_lead_activity_at",
      )
      .eq("id", client.clientHealthId)
      .maybeSingle();
    if (!data) return null;
    const row = data as Record<string, unknown>;
    return {
      plan: (row.plan as string) ?? null,
      paused: (row.client_paused as boolean) ?? null,
      weeklyTarget: (row.weekly_target as number) ?? null,
      monthlyTarget: (row.monthly_target as number) ?? null,
      introsThisMonth: (row.intros_this_month as number) ?? null,
      totalIntros: (row.total_intros_corofy as number) ?? null,
      stagnantIntros: (row.stagnant_intros_count as number) ?? null,
      lastLeadActivityAt: (row.last_lead_activity_at as string) ?? null,
    };
  } catch {
    return null;
  }
}

async function scrapingFor(client: ResolvedClient): Promise<ClientOverview["scraping"]> {
  if (!client.agentSearchClientId) return null;
  try {
    const as = db.agentSearch();
    const agents = await countOf(() =>
      as.from("orch_client_leads").select("id", { count: "exact", head: true })
        .eq("client_id", client.agentSearchClientId),
    );
    const { data } = await as
      .from("orch_client_leads").select("created_at")
      .eq("client_id", client.agentSearchClientId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    return { agents, lastScrapeAt: (data as { created_at?: string } | null)?.created_at ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// client_rankings
// ---------------------------------------------------------------------------

export type RankingSignal = "behind_target" | "gone_quiet" | "stagnant_intros";

export interface RankedClient {
  name: string;
  /** Intros booked this month against the month's target. */
  introsThisMonth: number | null;
  monthlyTarget: number | null;
  /** Negative means short of target. Null when there is no target to judge by. */
  vsTarget: number | null;
  daysSinceLeadActivity: number | null;
  stagnantIntros: number | null;
  paused: boolean | null;
  plan: string | null;
}

export interface RankingsResult {
  signal: RankingSignal;
  /** Worst first for a problem signal, best first for performance. */
  clients: RankedClient[];
  /** Clients Client Health does not cover, so they are absent from this list. */
  notCovered: string[];
  asOf: string;
}

/**
 * Best and worst performers.
 *
 * THREE SIGNALS, NOT ONE. "Performing badly" is three different problems on
 * this estate and they do not move together: a client can be at target while
 * every intro it produced went stale, or quiet for a fortnight while still
 * ahead for the month. The caller picks which one; the row carries all three
 * so an answer can say why.
 *
 * PAUSED CLIENTS ARE EXCLUDED from problem signals. A paused client is behind
 * target by arrangement, and listing it as a problem buries the clients that
 * are behind by accident.
 */
export async function clientRankingsTool(options: {
  signal?: RankingSignal;
  limit?: number;
  best?: boolean;
} = {}): Promise<RankingsResult | { error: string }> {
  const signal = options.signal ?? "behind_target";
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

  const roster = await resolveAll();
  const covered = roster.filter((c) => c.clientHealthId);
  const notCovered = roster.filter((c) => !c.clientHealthId).map((c) => c.name);

  let rows: Array<Record<string, unknown>>;
  try {
    const { data, error } = await db.clientHealth()
      .from("clients")
      .select(
        "id, name, plan, client_paused, weekly_target, monthly_target, intros_this_month, stagnant_intros_count, last_lead_activity_at",
      )
      .in("id", covered.map((c) => c.clientHealthId as string));
    if (error) return { error: `Client Health could not be read: ${String(error)}` };
    rows = (data ?? []) as Array<Record<string, unknown>>;
  } catch (error) {
    return { error: `Client Health could not be read: ${error instanceof Error ? error.message : error}` };
  }

  const now = Date.now();
  const clients: RankedClient[] = rows.map((r) => {
    const intros = (r.intros_this_month as number) ?? null;
    const target = (r.monthly_target as number) ?? null;
    const last = r.last_lead_activity_at as string | null;
    return {
      name: String(r.name ?? ""),
      introsThisMonth: intros,
      monthlyTarget: target,
      vsTarget: intros != null && target != null ? intros - target : null,
      daysSinceLeadActivity: last
        ? Math.floor((now - new Date(last).getTime()) / 86_400_000)
        : null,
      stagnantIntros: (r.stagnant_intros_count as number) ?? null,
      paused: (r.client_paused as boolean) ?? null,
      plan: (r.plan as string) ?? null,
    };
  });

  const active = options.best ? clients : clients.filter((c) => !c.paused);

  // `null` sorts last in every direction: an unknown is not a worst case.
  const by = (pick: (c: RankedClient) => number | null, worstFirst: boolean) =>
    [...active].sort((a, b) => {
      const av = pick(a), bv = pick(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return worstFirst ? av - bv : bv - av;
    });

  const ranked =
    signal === "behind_target"
      ? by((c) => c.vsTarget, !options.best)
      : signal === "gone_quiet"
        ? by((c) => c.daysSinceLeadActivity, false)
        : by((c) => c.stagnantIntros, false);

  return {
    signal,
    clients: ranked.slice(0, limit),
    notCovered,
    asOf: new Date().toISOString(),
  };
}
