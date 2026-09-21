import "server-only";

import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";

import { findClient, resolveAll } from "./identity.ts";
import { readOnly } from "./read-only.ts";

/*
 * The whole-business numbers: volume, reply rates, and the agent database.
 *
 * These are the questions a coverage sweep exposed as unanswerable — "how many
 * emails did we send last week", "which client has the best reply rate", "how
 * many agents do we have". Each one needs figures summed ACROSS clients, which
 * no earlier tool did.
 *
 * weekly_metrics is the source for volume and rates rather than the campaign
 * tables, for one reason: it is already per client per week, so a period total
 * is a sum over rows that exist, not a reconstruction from 570 campaigns'
 * lifetime counters that no date can be applied to.
 */

const db = {
  clientHealth: () => readOnly(getClientHealthSupabase()),
  agentSearch: () => readOnly(getAgentSearchSupabase()),
};

interface WeekRow {
  client_id: string;
  week_key: string;
  emails_sent: number | null;
  replies: number | null;
  intros_corofy: number | null;
}

/**
 * Every weekly_metrics row in a window, paged.
 *
 * 50 clients × 8 weeks is 400 rows, but a quarter is 650 and a year 2,600 —
 * past the 1,000 cap. Paged so a longer window does not silently become a
 * shorter one.
 */
async function weeksSince(weeks: number): Promise<{ rows: WeekRow[]; truncated: boolean }> {
  const since = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString().slice(0, 10);
  const ch = db.clientHealth();
  const out: WeekRow[] = [];
  let truncated = false;
  for (let page = 0; page < 20; page++) {
    const from = page * 1000;
    const { data, error } = await ch
      .from("weekly_metrics")
      .select("client_id, week_key, emails_sent, replies, intros_corofy")
      .gte("week_key", since)
      .order("week_key", { ascending: false })
      .range(from, from + 999);
    if (error) break;
    const rows = (data ?? []) as unknown as WeekRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
    if (page === 19) truncated = true;
  }
  return { rows: out, truncated };
}

// ---------------------------------------------------------------------------
// sending_volume
// ---------------------------------------------------------------------------

/**
 * How much we actually sent, and what came back — by week.
 *
 * THE CURRENT WEEK IS PARTIAL and is labelled so. Measured: the week of
 * 2026-09-14 closed at 99,067 emails; 2026-09-21 read 3,111 while still
 * running. Reporting the newest week beside the last as though both were
 * finished invites "sending has collapsed" when it has not.
 */
export async function sendingVolumeTool(options: { weeks?: number; client?: string } = {}) {
  const weeks = Math.min(Math.max(options.weeks ?? 6, 1), 52);

  let clientHealthId: string | null = null;
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
    if (!match.clientHealthId) {
      return { client: match.name, notLinked: "client_health", note: "Not tracked in Client Health, so its volume is unavailable." };
    }
    clientHealthId = match.clientHealthId;
  }

  const { rows, truncated } = await weeksSince(weeks);
  const scoped = clientHealthId ? rows.filter((r) => String(r.client_id) === clientHealthId) : rows;

  const byWeek = new Map<string, { emails: number; replies: number; intros: number; clients: Set<string> }>();
  for (const r of scoped) {
    const wk = String(r.week_key);
    const bucket = byWeek.get(wk) ?? { emails: 0, replies: 0, intros: 0, clients: new Set<string>() };
    bucket.emails += r.emails_sent ?? 0;
    bucket.replies += r.replies ?? 0;
    bucket.intros += r.intros_corofy ?? 0;
    bucket.clients.add(String(r.client_id));
    byWeek.set(wk, bucket);
  }

  const ordered = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const newest = ordered[0]?.[0];

  return {
    client: clientName,
    weeks: ordered.map(([week, b], i) => ({
      week,
      emails: b.emails,
      replies: b.replies,
      intros: b.intros,
      replyRate: b.emails > 0 ? Number((b.replies / b.emails).toFixed(4)) : null,
      clients: b.clients.size,
      ...(i === 0 && week === newest ? { partial: true } : {}),
    })),
    ...(truncated ? { truncated: true } : {}),
    note: "The newest week is marked partial — it is still running, so it is not comparable with the weeks before it.",
  };
}

// ---------------------------------------------------------------------------
// client_reply_rates
// ---------------------------------------------------------------------------

/**
 * Which clients get replies, best or worst.
 *
 * A rate needs volume behind it: one reply from forty sends is 2.5% and tells
 * you nothing, so clients below `minEmails` over the window are excluded and
 * the threshold is stated. Without it the top of this list would be whoever
 * happened to send least.
 */
export async function clientReplyRatesTool(options: { weeks?: number; best?: boolean; limit?: number; minEmails?: number } = {}) {
  const weeks = Math.min(Math.max(options.weeks ?? 6, 1), 52);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const minEmails = Math.max(options.minEmails ?? 1000, 1);

  const [{ rows }, roster] = await Promise.all([weeksSince(weeks), resolveAll()]);
  const nameByHealthId = new Map(roster.filter((c) => c.clientHealthId).map((c) => [c.clientHealthId as string, c.name]));

  const totals = new Map<string, { emails: number; replies: number; intros: number }>();
  for (const r of rows) {
    const id = String(r.client_id);
    const t = totals.get(id) ?? { emails: 0, replies: 0, intros: 0 };
    t.emails += r.emails_sent ?? 0;
    t.replies += r.replies ?? 0;
    t.intros += r.intros_corofy ?? 0;
    totals.set(id, t);
  }

  const ranked = [...totals.entries()]
    .filter(([, t]) => t.emails >= minEmails)
    .map(([id, t]) => ({
      client: nameByHealthId.get(id) ?? "(not on the roster)",
      emails: t.emails,
      replies: t.replies,
      intros: t.intros,
      replyRate: Number((t.replies / t.emails).toFixed(4)),
    }))
    .sort((a, b) => (options.best ? b.replyRate - a.replyRate : a.replyRate - b.replyRate));

  const overallEmails = [...totals.values()].reduce((n, t) => n + t.emails, 0);
  const overallReplies = [...totals.values()].reduce((n, t) => n + t.replies, 0);

  return {
    periodWeeks: weeks,
    overall: {
      emails: overallEmails,
      replies: overallReplies,
      replyRate: overallEmails > 0 ? Number((overallReplies / overallEmails).toFixed(4)) : null,
    },
    minEmailsToQualify: minEmails,
    clients: ranked.slice(0, limit),
    excludedForLowVolume: totals.size - ranked.length,
    note: `Clients under ${minEmails} emails in the window are excluded — a rate on a small denominator is noise.`,
  };
}

// ---------------------------------------------------------------------------
// agent_database
// ---------------------------------------------------------------------------

/**
 * The scraped agent database, and the MLS areas behind it.
 *
 * Counted in the database. `agents` is 1.18 million rows, so anything that
 * reads to count would be wrong by three orders of magnitude.
 */
export async function agentDatabaseTool() {
  const as = db.agentSearch();

  const count = async (table: string): Promise<number | null> => {
    try {
      const { count: n, error } = (await as
        .from(table)
        .select("id", { count: "exact", head: true })) as unknown as { count: number | null; error: unknown };
      return error ? null : n ?? 0;
    } catch {
      return null;
    }
  };

  const [agents, mlsAreas, offices] = await Promise.all([count("agents"), count("mls"), count("offices")]);

  // The MLS list is small (54), so the areas themselves are worth returning.
  const { data: mlsRows } = await as
    .from("mls")
    .select("code, name, state, member_agents")
    .order("member_agents", { ascending: false })
    .limit(60);

  return {
    agents,
    mlsAreas,
    offices,
    largestMls: ((mlsRows ?? []) as Array<Record<string, unknown>>).slice(0, 12).map((m) => ({
      code: String(m.code ?? ""),
      name: String(m.name ?? ""),
      state: String(m.state ?? ""),
      agents: (m.member_agents as number) ?? null,
    })),
    note: "`agents` is every agent ever scraped across all MLS areas, not a per-client figure.",
  };
}
