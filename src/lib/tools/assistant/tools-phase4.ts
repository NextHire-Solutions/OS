import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";
import { getSupabase as getClientHealthSupabase } from "@/lib/tools/client-health/supabase";

import { findClient } from "./identity.ts";
import { readOnly } from "./read-only.ts";
import { describeDbError } from "./describe-error.ts";

/*
 * The content tools: what we actually said, what came back, and what it costs.
 *
 * Everything before this reported COUNTS. These return text — email bodies,
 * reply bodies, offer names — which brings a hazard counts do not have: a
 * single reply can be a thousand words, and ten of them will crowd out the
 * question in the model's context and cost real money per turn. So every
 * body here is truncated at the source and the limit is small by default.
 */

const db = {
  masterInbox: () => readOnly(createAdminSupabase()),
  analytics: () => readOnly(getAnalyticsSupabase()),
  clientHealth: () => readOnly(getClientHealthSupabase()),
};

/** Long text, cut to something a model can read several of. */
function trim(text: unknown, max = 600): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

/*
 * Campaign ids, KEPT APART BY PLATFORM.
 *
 * The two id spaces are different types, not just different values: EmailBison
 * keys with a bigint and Instantly with a uuid. Putting both in one `in()`
 * against an EmailBison table is not a mismatch that returns fewer rows — it
 * is a 400, "invalid input syntax for type bigint", which surfaced as "54
 * Realty has no sequence steps" when it has fourteen. Their step bodies live
 * in different tables anyway.
 */
async function analyticsCampaignIds(
  analyticsClientId: string,
): Promise<{ emailBison: string[]; instantly: string[] }> {
  const an = db.analytics();
  const [eb, inst] = await Promise.all([
    an.from("campaign_clients").select("campaign_id").eq("client_id", analyticsClientId).eq("excluded", false),
    an.from("instantly_campaign_clients").select("campaign_id").eq("client_id", analyticsClientId).eq("excluded", false),
  ]);
  return {
    emailBison: ((eb.data ?? []) as Array<{ campaign_id: string | number }>).map((r) => String(r.campaign_id)),
    instantly: ((inst.data ?? []) as Array<{ campaign_id: string | number }>).map((r) => String(r.campaign_id)),
  };
}

// ---------------------------------------------------------------------------
// campaign_copy
// ---------------------------------------------------------------------------

/**
 * What a client's emails actually say, and which offer they sell.
 *
 * VARIANTS ARE EXCLUDED BY DEFAULT. A campaign's sequence is a handful of
 * steps, but each can carry several A/B variants, so "show me the sequence"
 * returns twenty near-identical emails unless asked otherwise — and the
 * differences between variants are exactly what gets lost when twenty bodies
 * are truncated to fit.
 */
export async function campaignCopyTool(clientQuery: string, options: { includeVariants?: boolean } = {}) {
  const { match, candidates } = await findClient(clientQuery);
  if (!match) {
    return {
      error: candidates.length ? `"${clientQuery}" matches several clients. Ask which one.` : `No client named "${clientQuery}".`,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  if (!match.analyticsClientId) {
    return { client: match.name, notLinked: "analytics", note: "Not linked to Campaign Analytics, so its copy cannot be read. That is not the same as having none." };
  }

  const ids = await analyticsCampaignIds(match.analyticsClientId);
  if (!ids.emailBison.length && !ids.instantly.length) {
    return { client: match.name, offers: [], steps: [], note: "No campaigns are linked to this client." };
  }

  const an = db.analytics();

  // Offers are recorded against EmailBison campaigns only.
  const { data: offerLinks } = ids.emailBison.length
    ? await an.from("campaign_offers").select("offer_id").in("campaign_id", ids.emailBison)
    : { data: [] };
  const offerIds = [...new Set(((offerLinks ?? []) as Array<{ offer_id: string }>).map((r) => String(r.offer_id)))];
  let offers: Array<{ name: string; niche: string | null }> = [];
  if (offerIds.length) {
    const { data } = await an.from("offers").select("name, niche").in("id", offerIds);
    offers = ((data ?? []) as Array<Record<string, unknown>>).map((o) => ({
      name: String(o.name ?? ""),
      niche: (o.niche as string) ?? null,
    }));
  }

  const readSteps = async (table: string, campaignIds: string[]) => {
    if (!campaignIds.length) return [];
    let q = an
      .from(table)
      .select("campaign_id, step_order, email_subject, email_body, wait_in_days, is_variant")
      .in("campaign_id", campaignIds)
      .order("step_order", { ascending: true })
      .limit(40);
    if (!options.includeVariants) q = q.eq("is_variant", false);
    const { data, error } = await q;
    if (error) return [];
    return (data ?? []) as Array<Record<string, unknown>>;
  };

  const [ebSteps, instSteps] = await Promise.all([
    readSteps("sequence_steps", ids.emailBison),
    readSteps("instantly_sequence_steps", ids.instantly),
  ]);

  const steps = [
    ...ebSteps.map((s) => ({ platform: "emailbison" as const, row: s })),
    ...instSteps.map((s) => ({ platform: "instantly" as const, row: s })),
  ].map(({ platform, row }) => ({
    platform,
    step: (row.step_order as number) ?? null,
    waitDays: (row.wait_in_days as number) ?? null,
    subject: trim(row.email_subject, 200),
    body: trim(row.email_body, 700),
    isVariant: Boolean(row.is_variant),
  }));

  return {
    client: match.name,
    offers,
    steps,
    note: options.includeVariants ? undefined : "A/B variants are omitted; ask for variants to see them.",
  };
}

// ---------------------------------------------------------------------------
// recent_replies
// ---------------------------------------------------------------------------

/**
 * What leads actually wrote back.
 *
 * Bodies are truncated hard and the default count is small. Ten untrimmed
 * replies would be most of the model's context for one question, and the
 * answer would be worse for it, not better.
 */
export async function recentRepliesTool(options: { client?: string; label?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const mi = db.masterInbox();

  let clientName: string | null = null;
  let threadIds: string[] | null = null;

  if (options.client) {
    const { match, candidates } = await findClient(options.client);
    if (!match) {
      return {
        error: candidates.length ? `"${options.client}" matches several clients. Ask which one.` : `No client named "${options.client}".`,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
      };
    }
    clientName = match.name;
    /*
     * Capped at 400 threads, and said out loud when it bites. A client with
     * 1,293 threads cannot have them all in one URL, and silently reading the
     * newest 400 would make "their last reply" mean "their last reply among
     * some of their threads".
     */
    const { data } = await mi
      .from("threads").select("id").eq("client_id", match.id)
      .order("updated_at", { ascending: false }).limit(400);
    threadIds = ((data ?? []) as Array<{ id: string }>).map((t) => t.id);
    if (!threadIds.length) return { client: clientName, replies: [], note: "This client has no threads." };
  }

  // A label narrows to a kind of reply — "the last interested lead".
  if (options.label) {
    const { data } = await mi
      .from("v_reply_labels").select("thread_id")
      .ilike("label_name", options.label)
      .order("labelled_at", { ascending: false })
      .limit(400);
    const labelled = ((data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id);
    threadIds = threadIds ? threadIds.filter((id) => labelled.includes(id)) : labelled;
    if (!threadIds.length) {
      return { client: clientName, label: options.label, replies: [], note: "No replies match that label in the recent window." };
    }
  }

  let query = mi
    .from("messages")
    .select("thread_id, sender, subject, body_text, sent_at")
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (threadIds) query = query.in("thread_id", threadIds.slice(0, 200));

  const { data, error } = await query;
  if (error) return { error: `Master Inbox could not be read: ${describeDbError(error)}` };

  return {
    client: clientName,
    label: options.label ?? null,
    replies: ((data ?? []) as Array<Record<string, unknown>>).map((m) => ({
      from: trim(m.sender, 120),
      subject: trim(m.subject, 160),
      text: trim(m.body_text, 700),
      at: String(m.sent_at ?? ""),
    })),
  };
}

// ---------------------------------------------------------------------------
// inbox_deliverability
// ---------------------------------------------------------------------------

/**
 * Which mailboxes are bouncing, worst first.
 *
 * Ordered and limited IN THE DATABASE. Reading 1,805 senders to sort them here
 * would stop at 1,000 and call the worst of that slice the worst overall —
 * and the fleet's actual problem inboxes are exactly the tail that would be
 * cut off.
 *
 * A bounce RATE needs volume behind it: one bounce from two sends is 50% and
 * means nothing, so anything under `minSent` is excluded and the threshold is
 * reported.
 */
export async function inboxDeliverabilityTool(options: { minSent?: number; limit?: number } = {}) {
  const minSent = Math.max(options.minSent ?? 200, 1);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);

  const { data, error } = await db
    .analytics()
    .from("sender_emails")
    .select("email, domain, status, lifetime_sent, lifetime_bounced, lifetime_replied")
    .gte("lifetime_sent", minSent)
    .order("lifetime_bounced", { ascending: false })
    .limit(limit * 4);
  if (error) return { error: `Analytics could not be read: ${describeDbError(error)}` };

  const rows = ((data ?? []) as Array<Record<string, unknown>>)
    .map((r) => {
      const sent = (r.lifetime_sent as number) ?? 0;
      const bounced = (r.lifetime_bounced as number) ?? 0;
      return {
        inbox: String(r.email ?? ""),
        domain: String(r.domain ?? ""),
        status: String(r.status ?? ""),
        sent,
        bounced,
        bounceRate: sent > 0 ? Number((bounced / sent).toFixed(4)) : null,
        replies: (r.lifetime_replied as number) ?? 0,
      };
    })
    .sort((a, b) => (b.bounceRate ?? 0) - (a.bounceRate ?? 0))
    .slice(0, limit);

  return {
    minSentToQualify: minSent,
    worst: rows,
    note:
      `Ranked by bounce rate among inboxes that have sent at least ${minSent} emails — a rate on a ` +
      `handful of sends is noise. Ordered in the database, so these are the worst of the whole fleet.`,
  };
}

// ---------------------------------------------------------------------------
// client_commercials
// ---------------------------------------------------------------------------

/**
 * The commercial shape of a client: plan, billing rhythm, campaign size.
 *
 * NO REVENUE FIGURE IS RETURNED, because none is stored. Client Health keeps
 * the plan name, the billing interval and the anchor date — not a price. An
 * assistant that multiplied a plan name into a number would be inventing the
 * most quotable figure in the business.
 */
export async function clientCommercialsTool(clientQuery: string) {
  const { match, candidates } = await findClient(clientQuery);
  if (!match) {
    return {
      error: candidates.length ? `"${clientQuery}" matches several clients. Ask which one.` : `No client named "${clientQuery}".`,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  if (!match.clientHealthId) {
    return { client: match.name, notLinked: "client_health", note: "Not tracked in Client Health, so its plan and billing are unavailable." };
  }

  const { data } = await db
    .clientHealth()
    .from("clients")
    .select("plan, campaign_size, billing_interval, billing_interval_days, billing_anchor_date, start_date, weekly_target, monthly_target, client_paused, time_zone")
    .eq("id", match.clientHealthId)
    .maybeSingle();
  if (!data) return { client: match.name, note: "No Client Health record found." };

  const r = data as Record<string, unknown>;
  return {
    client: match.name,
    plan: (r.plan as string) ?? null,
    campaignSize: (r.campaign_size as number) ?? null,
    billing: {
      interval: (r.billing_interval as string) ?? null,
      intervalDays: (r.billing_interval_days as number) ?? null,
      anchorDate: (r.billing_anchor_date as string) ?? null,
    },
    startDate: (r.start_date as string) ?? null,
    weeklyTarget: (r.weekly_target as number) ?? null,
    monthlyTarget: (r.monthly_target as number) ?? null,
    paused: (r.client_paused as boolean) ?? null,
    timeZone: (r.time_zone as string) ?? null,
    note: "No price or revenue is stored anywhere in these systems — the plan name is not a figure.",
  };
}
