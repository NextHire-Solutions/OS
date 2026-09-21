import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";

import { findClient } from "./identity.ts";
import { readOnly } from "./read-only.ts";

/*
 * The detail tools: campaigns, scrapes, inbox activity, the reply agent.
 *
 * Same rules as phase 1 and for the same reasons — counted in the database,
 * a gap reported rather than zeroed, and no tool that can write. What is new
 * here is that three of these answer a question with a LIST, and a list has a
 * failure mode a count does not: PostgREST stops at 1,000 rows without saying
 * so, so a list that hits its limit says it was truncated instead of quietly
 * being the answer.
 */

const db = {
  masterInbox: () => readOnly(createAdminSupabase()),
  analytics: () => readOnly(getAnalyticsSupabase()),
  agentSearch: () => readOnly(getAgentSearchSupabase()),
};

// ---------------------------------------------------------------------------
// campaigns_for_client
// ---------------------------------------------------------------------------

export interface CampaignRow {
  name: string;
  platform: string;
  status: string;
  leads: number | null;
  emailsSent: number | null;
  replies: number | null;
  replyRate: number | null;
}

export async function campaignsForClientTool(clientQuery: string, options: { activeOnly?: boolean } = {}) {
  const { match, candidates } = await findClient(clientQuery);
  if (!match) {
    return {
      error: candidates.length ? `"${clientQuery}" matches several clients. Ask which one.` : `No client named "${clientQuery}".`,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  if (!match.analyticsClientId) {
    return {
      client: match.name,
      notLinked: "analytics",
      note: "This client is not linked to Campaign Analytics, so its campaigns cannot be listed. That is not the same as having none.",
    };
  }

  const an = db.analytics();
  const [eb, inst] = await Promise.all([
    an.from("campaign_clients").select("campaign_id").eq("client_id", match.analyticsClientId).eq("excluded", false),
    an.from("instantly_campaign_clients").select("campaign_id").eq("client_id", match.analyticsClientId).eq("excluded", false),
  ]);
  const ids = [
    ...((eb.data ?? []) as Array<{ campaign_id: string | number }>).map((r) => String(r.campaign_id)),
    ...((inst.data ?? []) as Array<{ campaign_id: string | number }>).map((r) => String(r.campaign_id)),
  ];
  if (!ids.length) return { client: match.name, campaigns: [], total: 0 };

  const { data } = await an
    .from("campaigns_unified")
    .select("name, platform, status, total_leads, lifetime_emails_sent, lifetime_unique_replies")
    .in("id", ids);

  let rows = ((data ?? []) as Array<Record<string, unknown>>).map((r): CampaignRow => {
    const sent = (r.lifetime_emails_sent as number) ?? null;
    const replies = (r.lifetime_unique_replies as number) ?? null;
    return {
      name: String(r.name ?? ""),
      platform: String(r.platform ?? ""),
      status: String(r.status ?? ""),
      leads: (r.total_leads as number) ?? null,
      emailsSent: sent,
      replies,
      replyRate: sent && sent > 0 && replies != null ? Number((replies / sent).toFixed(4)) : null,
    };
  });

  if (options.activeOnly) rows = rows.filter((r) => r.status.toLowerCase() === "active");
  rows.sort((a, b) => (b.emailsSent ?? 0) - (a.emailsSent ?? 0));

  return { client: match.name, total: rows.length, campaigns: rows.slice(0, 40) };
}

// ---------------------------------------------------------------------------
// scrape_activity
// ---------------------------------------------------------------------------

/**
 * What was scraped, and when.
 *
 * A "scrape" here is an enrichment BATCH — a run that took a set of agents and
 * found contact details for them. `enrichment_batches` carries the client, the
 * campaign it fed, and the counts that say whether it worked: total, enriched,
 * no_email, sent, failed.
 *
 * It is keyed by `orch_client_id`, the Agent Search client — which is exactly
 * the id the identity layer resolves and the one 24 of our 59 clients do not
 * have. Asked about one of those, this says so.
 */
export async function scrapeActivityTool(options: { client?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const as = db.agentSearch();

  let orchId: string | null = null;
  let clientName: string | null = null;
  if (options.client) {
    const { match, candidates } = await findClient(options.client);
    if (!match) {
      return {
        error: candidates.length ? `"${options.client}" matches several clients. Ask which one.` : `No client named "${options.client}".`,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      };
    }
    clientName = match.name;
    if (!match.agentSearchClientId) {
      return {
        client: match.name,
        notLinked: "agent_search",
        note: "This client is not linked to Agent Search, so its scrapes cannot be listed. That is not the same as never having been scraped.",
      };
    }
    orchId = match.agentSearchClientId;
  }

  let query = as
    .from("enrichment_batches")
    .select("campaign_name, status, total, enriched, no_email, sent, failed, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (orchId) query = query.eq("orch_client_id", orchId);

  const { data, error } = await query;
  if (error) return { error: `Agent Search could not be read: ${String(error)}` };

  const batches = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    campaign: String(r.campaign_name ?? ""),
    status: String(r.status ?? ""),
    agents: (r.total as number) ?? null,
    withEmail: (r.enriched as number) ?? null,
    withoutEmail: (r.no_email as number) ?? null,
    sent: (r.sent as number) ?? null,
    failed: (r.failed as number) ?? null,
    at: String(r.created_at ?? ""),
  }));

  return { client: clientName, batches, count: batches.length };
}

// ---------------------------------------------------------------------------
// inbox_activity
// ---------------------------------------------------------------------------

/**
 * What the inbox has been doing — how replies were classified.
 *
 * THE LABEL VOCABULARIES DO NOT MATCH, and the first version of this was
 * silently wrong because of it. It took the label list from the `labels`
 * table and counted matching rows in `v_reply_labels`. But the view speaks a
 * different vocabulary: it has "Unsubscribe", "Not Qualified" and
 * "Broker/Owner", which are not in `labels` at all, and "OOO" where `labels`
 * says "OOO Sequence". Only the handful of names that happened to coincide
 * were counted, so a true 2,091 replies over thirty days — Not Interested
 * 469, Unsubscribe 156, Introduction 116 — was reported as 114, of which 113
 * were "Keep Warm". Confident, specific, and wrong.
 *
 * So the labels come from THE ROWS THEMSELVES. The period is paged through
 * and tallied exactly rather than sampled: a sample would find the common
 * labels and quietly miss a rare one, and "no Interested replies this month"
 * is precisely the answer that must never be an artefact of where a read
 * stopped.
 */
export async function inboxActivityTool(options: { days?: number } = {}) {
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const mi = db.masterInbox();

  const PAGE = 1000;
  // 30 pages is 30,000 replies — more than the whole view holds today, so in
  // practice this never truncates. It exists so a future estate ten times the
  // size degrades into a reported truncation rather than a silent one.
  const MAX_PAGES = 30;

  const tally = new Map<string, number>();
  let scanned = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const { data, error } = await mi
      .from("v_reply_labels")
      .select("label_name")
      .gte("labelled_at", since)
      .order("labelled_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return { error: `Master Inbox could not be read: ${String(error)}` };

    const rows = (data ?? []) as Array<{ label_name: string | null }>;
    for (const row of rows) {
      const name = row.label_name;
      if (!name) continue;
      tally.set(name, (tally.get(name) ?? 0) + 1);
    }
    scanned += rows.length;
    if (rows.length < PAGE) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  const byLabel = [...tally.entries()]
    .map(([label, replies]) => ({ label, replies }))
    .sort((a, b) => b.replies - a.replies);

  return {
    periodDays: days,
    since,
    totalLabelled: byLabel.reduce((n, c) => n + c.replies, 0),
    byLabel,
    scanned,
    ...(truncated
      ? { truncated: true, note: `Stopped after ${scanned} replies — the real total is higher.` }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// reply_agent_status
// ---------------------------------------------------------------------------

/**
 * What the reply agent has actually done.
 *
 * Read from v_reply_agent_stats, the same view the Reply Agent screen and the
 * stats API use — so a figure here and a figure there cannot disagree, which
 * is the whole reason that view exists rather than a second tally.
 */
export async function replyAgentStatusTool() {
  const { data, error } = await db
    .masterInbox()
    .from("v_reply_agent_stats")
    .select(
      "name, run_mode, active, client_ids, schedule, replies_drafted, replies_sent, drafts_failed, lead_replies_received, " +
        "qualification_started, qualification_qualified, qualification_handed_over, qualification_stopped, sends_held, " +
        "reply_rate, tokens_total",
    );
  if (error) return { error: `The reply agent stats could not be read: ${String(error)}` };

  const agents = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    name: String(r.name ?? ""),
    mode: String(r.run_mode ?? ""),
    active: Boolean(r.active),
    // An empty client list means the agent covers EVERY client — the single
    // most consequential fact about an agent, and the easiest to misread.
    clients: Array.isArray(r.client_ids) && r.client_ids.length ? r.client_ids.length : "all clients",
    drafted: (r.replies_drafted as number) ?? 0,
    sent: (r.replies_sent as number) ?? 0,
    failed: (r.drafts_failed as number) ?? 0,
    heldBySafetyGate: (r.sends_held as number) ?? 0,
    qualified: (r.qualification_qualified as number) ?? 0,
    handedOver: (r.qualification_handed_over as number) ?? 0,
    tokens: (r.tokens_total as number) ?? 0,
  }));

  return {
    agents,
    note:
      "`sent` counts drafts that went out, including those a person sent from the composer — it is not " +
      "the number the agent sent by itself. An agent in shadow mode never sends on its own.",
  };
}
