import "server-only";

import { campaignPortalView } from "@/lib/clients/campaign-portals";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { readOnly } from "./read-only.ts";
import { campaignsForClientTool, scrapeActivityTool } from "./tools-phase2.ts";
import { sendingVolumeTool } from "./tools-phase5.ts";
import { clientBillingTool, clientIntroductionTool, clientRecordTool, matchMasterClient } from "./tools-phase7.ts";
import { campaignKpisTool, clientSuccessTool } from "./tools-phase8.ts";

/*
 * client_report — one client, every product, already digested (6 Oct).
 *
 * "How is Raintown doing? Full report" was answered from client_overview
 * alone: inbox counts, lifetime campaign totals, Client Health targets and a
 * scrape count. No money, no account manager, nothing from Campaign Analytics
 * for a period, no comparison with anything — so the model listed fields
 * ("Open threads: 299") instead of judging the account.
 *
 * This reads every source in parallel and does the arithmetic itself — the
 * comparisons, the trend, the flags and a verdict — because a model asked to
 * count a list or compare two rates gets it wrong often enough to matter
 * (it said Amy had 30 active clients; she has 22). The model's job is only to
 * write it up, in the shape the system prompt gives.
 *
 * A source that fails is listed in `unavailable` and the rest still answer.
 */

const mi = () => readOnly(createAdminSupabase());
const DAY = 86_400_000;
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 100);
const change = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

type Flag = { severity: "high" | "medium"; area: string; issue: string; nextStep: string };

/** Pipeline stages as the portal names them. */
const STAGE_LABEL: Record<string, string> = {
  introduction: "Introduced (no update yet)", phone_screen_scheduled: "Phone screen scheduled", phone_screen: "Phone screen done",
  interview_scheduled: "Interview scheduled", interview: "Interviewed", hired: "Hired", keep_warm: "Keep warm",
  no_show: "No-show", we_they_rejected: "Rejected (either side)",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-05…" → "5 Oct 2026". */
const day = (d: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
};

async function safely<T>(what: string, gaps: string[], work: () => Promise<T>): Promise<T | null> {
  try {
    const out = await work();
    const err = (out as { error?: unknown; note?: unknown } | null)?.error;
    if (err) { gaps.push(`${what}: ${String(err)}`); return null; }
    return out;
  } catch (e) {
    gaps.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Every pipeline entry of the client's portals: stage and dates, paged. */
async function pipelineRows(portalIds: string[]) {
  const out: Array<{ stage: string | null; introduced_at: string | null; hired_at: string | null }> = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await mi().from("client_pipeline_entries")
      .select("stage, introduced_at, hired_at").in("client_id", portalIds)
      .order("introduced_at", { ascending: false }).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as typeof out));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/** How this client's replies were labelled in the window, from its portals' conversations. */
async function replyMix(portalIds: string[], since: string) {
  const { data: threads, error } = await mi().from("threads").select("id")
    .in("client_id", portalIds).gte("last_message_at", since).limit(1000);
  if (error) throw new Error(error.message);
  const ids = ((threads ?? []) as Array<{ id: string }>).map((t) => t.id);
  const counts: Record<string, number> = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await mi().from("v_reply_labels").select("label_name")
      .in("thread_id", ids.slice(i, i + 150)).gte("labelled_at", since);
    for (const r of (data ?? []) as Array<{ label_name: string | null }>) {
      const k = r.label_name ?? "Unlabelled";
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

type Kpi = { sent?: number; replies?: number; replyRate?: number | null; positive?: number | null; positiveRate?: number | null; bounces?: number | null; bounceRate?: number | null };

export async function clientReportTool(query: string) {
  const { match, candidates } = await matchMasterClient(query);
  if (!match) {
    return candidates.length
      ? { candidates, note: "Several clients match. Ask which one — do not pick." }
      : { note: `No client on the master record matches "${query}".` };
  }
  const name = match.name;
  const gaps: string[] = [];
  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

  const portals = await safely("portals", gaps, () => campaignPortalView(match.id));
  const portalIds = (portals?.portals ?? []).map((p) => p.id);

  const [record, billing, campaigns, weekly, success, intro, scrape, pipeline, mix] = await Promise.all([
    safely("master record", gaps, () => clientRecordTool(name)),
    safely("Stripe billing", gaps, () => clientBillingTool(name)),
    safely("campaigns", gaps, () => campaignsForClientTool(name)),
    safely("weekly volume (Client Health)", gaps, () => sendingVolumeTool({ weeks: 6, client: name })),
    safely("account health (Client Health)", gaps, () => clientSuccessTool()),
    safely("introduction setup", gaps, () => clientIntroductionTool(name)),
    safely("scraping", gaps, () => scrapeActivityTool({ client: name, limit: 3 })),
    portalIds.length ? safely("portal pipeline", gaps, () => pipelineRows(portalIds)) : Promise.resolve(null),
    portalIds.length ? safely("reply labels", gaps, () => replyMix(portalIds, iso(30))) : Promise.resolve(null),
  ]);

  // Campaign Analytics on the client's own platforms, against the business on the same ones.
  type Camp = { name: string; platform: string; status: string; leads?: number; emailsSent?: number; replies?: number; replyRate?: number; dailySendLimit?: number | null; dailyNewLeadLimit?: number | null };
  const camps = ((campaigns as { campaigns?: Camp[] } | null)?.campaigns ?? []);
  const platformsUsed = [...new Set(camps.map((c) => c.platform))];
  const platform = platformsUsed.length === 1 && (platformsUsed[0] === "emailbison" || platformsUsed[0] === "instantly") ? (platformsUsed[0] as "emailbison" | "instantly") : undefined;
  const [kpiClient, kpiBusiness] = await Promise.all([
    safely("Campaign Analytics (client)", gaps, () => campaignKpisTool({ period: "30d", client: name, platform })),
    safely("Campaign Analytics (business)", gaps, () => campaignKpisTool({ period: "30d", platform })),
  ]);
  const kc = (kpiClient as { current?: Kpi; previous?: Kpi; note?: string } | null);
  const kb = (kpiBusiness as { current?: Kpi } | null)?.current;
  if (kc?.note) gaps.push(`Campaign Analytics: ${kc.note}`);

  // ---- introductions and results, from the portal pipeline itself
  const rows = pipeline ?? [];
  const within = (d: string | null, from: number, to = 0) => !!d && Date.parse(d) >= now - from * DAY && Date.parse(d) < now - to * DAY;
  const intros = {
    allTime: rows.length,
    last7: rows.filter((r) => within(r.introduced_at, 7)).length,
    last30: rows.filter((r) => within(r.introduced_at, 30)).length,
    previous30: rows.filter((r) => within(r.introduced_at, 60, 30)).length,
    lastIntroduction: day(rows.map((r) => r.introduced_at).filter(Boolean).sort().pop()),
  };
  const byStage = rows.reduce<Record<string, number>>((m, r) => { const k = r.stage ?? "unknown"; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const hires = {
    allTime: rows.filter((r) => r.hired_at || r.stage === "hired").length,
    last90: rows.filter((r) => within(r.hired_at, 90)).length,
    lastHire: day(rows.map((r) => r.hired_at).filter(Boolean).sort().pop()),
  };

  // ---- the master record and money
  const rec = record as Record<string, unknown> | null;
  const people = (rec?.people ?? {}) as { accountManager?: string; salesperson?: string };
  const cycle = (rec?.thisCycle ?? null) as { delivered: number; required: number; carryIn: number } | null;
  const schedule = (rec?.billingSchedule ?? null) as { interval?: string; nextBillingDate?: string | null } | null;
  const targets = (rec?.targets ?? null) as { weekly?: number; monthly?: number } | null;
  const bill = billing as { linkedToStripe?: boolean; mrr?: number; totalSpend?: number; subscription?: { status?: string; nextCharge?: string; collectionPaused?: boolean }; outstanding?: { invoices: number; amount: number; pastDue: number } } | null;
  const health = ((success as { clients?: Array<{ client: string; healthScore: number | null; hiredTotal: number; lastHire: string | null }> } | null)?.clients ?? [])
    .find((c) => c.client.toLowerCase() === name.toLowerCase()) ?? null;
  const daysToBilling = schedule?.nextBillingDate ? Math.ceil((Date.parse(schedule.nextBillingDate) - now) / DAY) : null;

  // ---- campaigns, last 30 days vs the business
  const clientRate = kc?.current?.replyRate ?? null;
  const businessRate = kb?.replyRate ?? null;
  const vsBusiness = clientRate != null && businessRate ? Math.round((clientRate / businessRate) * 100) / 100 : null;
  const active = camps.filter((c) => c.status === "active");
  const weeks = ((weekly as { weeks?: Array<{ week: string; emails: number; replies: number; intros: number; replyRate: number | null; partial?: boolean }> } | null)?.weeks ?? []);
  const lastFullWeek = weeks.find((w) => !w.partial);

  // ---- flags and strengths: computed here so they are never miscounted
  const flags: Flag[] = [];
  const strengths: string[] = [];
  const am = people.accountManager ?? match.accountManager ?? "the account manager";
  const status = String(rec?.status ?? match.status);
  const stopped = status === "paused" || status === "churned";
  const charging = bill?.subscription?.status === "active" && !bill.subscription.collectionPaused;
  if (stopped) {
    // A paused or churned client should send nothing and be charged nothing (paused, never cancelled).
    if (active.length) flags.push({ severity: "high", area: "Campaigns", issue: `${active.length} campaign(s) still active although the client is ${status}.`, nextStep: "Pause them in Campaign Analytics." });
    if (charging) flags.push({ severity: "high", area: "Billing", issue: `Stripe is still charging although the client is ${status}.`, nextStep: "Pause collection on the subscription in Stripe — pause, do not cancel." });
    if (!active.length && !charging) strengths.push(`Campaigns and Stripe billing are stopped to match the ${status} status.`);
  }
  if (bill?.outstanding && (bill.outstanding.pastDue > 0 || bill.outstanding.amount > 0)) {
    flags.push({ severity: "high", area: "Billing", issue: `$${bill.outstanding.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })} outstanding across ${bill.outstanding.invoices} invoice(s), ${bill.outstanding.pastDue} past due.`, nextStep: "Chase the open invoice(s) in Stripe before the next charge." });
  } else if (bill?.subscription?.status === "active") strengths.push("Billing is clean: subscription active and nothing outstanding.");
  if (bill?.subscription?.collectionPaused && status === "active") flags.push({ severity: "medium", area: "Billing", issue: "Stripe collection is paused although the client is active.", nextStep: "Resume collection in Stripe, or pause the client if that is the intent." });
  if (status === "active" && camps.length && !active.length) flags.push({ severity: "high", area: "Campaigns", issue: "No active campaign — nothing is being sent for this client.", nextStep: "Launch or resume a campaign for this client in Campaign Analytics." });
  if (status === "active" && lastFullWeek && lastFullWeek.emails === 0) flags.push({ severity: "high", area: "Campaigns", issue: `No emails sent in the week of ${day(lastFullWeek.week)}.`, nextStep: "Check the campaign's status, daily limit and connected inboxes in Campaign Analytics." });
  if (!stopped && cycle && cycle.delivered != null && cycle.delivered < cycle.required) {
    flags.push({ severity: daysToBilling != null && daysToBilling <= 3 ? "high" : "medium", area: "Introductions", issue: `${cycle.delivered} of ${cycle.required} introductions owed this billing cycle are delivered${daysToBilling != null ? `, ${daysToBilling} day(s) before billing on ${day(schedule?.nextBillingDate)}` : ""}.`, nextStep: "Work this client's Interested and Keep Warm replies in Master Inbox first until the cycle is covered." });
  } else if (!stopped && cycle && cycle.delivered != null && cycle.required > 0) strengths.push(`This billing cycle is covered: ${cycle.delivered} introductions delivered of ${cycle.required} required.`);
  const introTrend = change(intros.last30, intros.previous30);
  if (!stopped && introTrend != null && intros.previous30 >= 4 && introTrend <= -40) flags.push({ severity: "medium", area: "Introductions", issue: `Introductions fell ${Math.abs(introTrend)}%: ${intros.last30} in the last 30 days vs ${intros.previous30} in the 30 before.`, nextStep: "Compare sends and reply rate with last month in Campaign Analytics — fewer sends or fewer positive replies?" });
  else if (introTrend != null && intros.previous30 >= 3 && introTrend >= 25) strengths.push(`Introductions up ${introTrend}%: ${intros.last30} in the last 30 days vs ${intros.previous30} before.`);
  const posRate = kc?.current?.positiveRate ?? null, posBiz = kb?.positiveRate ?? null;
  if (!stopped && vsBusiness != null && (kc?.current?.sent ?? 0) >= 1000) {
    if (vsBusiness < 0.7) flags.push({ severity: "medium", area: "Campaigns", issue: `Reply rate ${pct(clientRate)}% over the last 30 days — ${Math.round((1 - vsBusiness) * 100)}% below the business average of ${pct(businessRate)}%.`, nextStep: "Review the copy and offer (Campaign Analytics → Copy & Offer) and the lead list for this market." });
    if (vsBusiness >= 1.3) strengths.push(`Reply rate ${pct(clientRate)}% over the last 30 days — ${Math.round((vsBusiness - 1) * 100)}% above the business average of ${pct(businessRate)}%.`);
  }
  if (!stopped && posRate != null && posBiz && (kc?.current?.replies ?? 0) >= 50 && posRate < posBiz * 0.7) {
    flags.push({ severity: "medium", area: "Campaigns", issue: `Positive rate ${pct(posRate)}% of replies — below the business average of ${pct(posBiz)}%: people reply, but fewer are interested.`, nextStep: "Look at the Not Interested and Objection replies for a pattern, and test a stronger offer." });
  }
  const bounceRate = kc?.current?.bounceRate ?? null;
  if (!stopped && bounceRate != null && bounceRate > 0.02 && (kc?.current?.sent ?? 0) >= 1000) flags.push({ severity: "medium", area: "Deliverability", issue: `Bounce rate ${pct(bounceRate)}% over the last 30 days.`, nextStep: "Check the lead list's email verification and the sending inboxes (Infrastructure)." });
  const noShow = byStage.no_show ?? 0;
  if (!stopped && rows.length >= 20 && noShow / rows.length > 0.4) flags.push({ severity: "medium", area: "Pipeline", issue: `${noShow} of ${rows.length} introduced agents (${Math.round((noShow / rows.length) * 100)}%) are marked no-show.`, nextStep: `Have ${am} review the no-shows with the client: are introduced agents being called within a day of the introduction?` });
  if (!stopped && rows.length >= 30 && hires.allTime === 0) flags.push({ severity: "medium", area: "Results", issue: `No hires recorded from ${rows.length} introductions.`, nextStep: `Ask ${am} to confirm with the client whether any introduced agents joined and the portal simply was not updated.` });
  if (hires.last90 > 0) strengths.push(`${hires.last90} hire(s) in the last 90 days.`);
  if (!stopped && health?.healthScore != null && health.healthScore < 4) flags.push({ severity: "medium", area: "Account health", issue: `Client Health score ${health.healthScore} out of 10.`, nextStep: `Review the account with ${am} — the score falls with no hires, stalled introductions and slow pace.` });
  // Client Health's cycle and Stripe's charge must agree — the cycle's "owed by" date rests on it.
  const stripeNext = bill?.subscription?.nextCharge ?? null;
  if (!stopped && charging && stripeNext && Date.parse(stripeNext) > now && schedule?.nextBillingDate && Math.abs(Date.parse(schedule.nextBillingDate) - Date.parse(stripeNext)) > 1.5 * DAY) {
    flags.push({ severity: "medium", area: "Data", issue: `The billing cycle on the client record ends ${day(schedule.nextBillingDate)}, but Stripe next charges on ${day(stripeNext)} — the introductions-owed deadline above uses the record's date.`, nextStep: "Correct the billing anchor date on the client record (Clients → Record) to match Stripe." });
  }
  for (const c of active) {
    if ((c.dailySendLimit ?? 1) === 0) flags.push({ severity: "medium", area: "Campaigns", issue: `Active campaign "${c.name}" has a daily send limit of 0.`, nextStep: "Raise the daily send limit in the campaign's settings." });
  }
  const verdict = status === "churned" ? "Churned" : status === "paused" ? "Paused"
    : flags.some((f) => f.severity === "high") ? "At risk" : flags.length ? "Needs attention" : "On track";

  return {
    client: name,
    verdict,
    attention: flags,
    strengths,
    account: {
      status,
      statusSince: day(String(rec?.statusSince ?? "")),
      plan: rec?.plan ?? match.plan ?? null,
      clientSince: day((rec?.dates as { start?: string } | undefined)?.start ?? match.startDate ?? null),
      accountManager: people.accountManager ?? match.accountManager ?? null,
      salesperson: people.salesperson ?? match.salesperson ?? null,
      markets: rec?.markets ?? null,
      portals: (portals?.portals ?? []).map((p) => p.name),
    },
    money: bill?.linkedToStripe === false ? { linkedToStripe: false, note: "Not linked to Stripe — MRR and spend unknown, not zero." } : bill ? {
      mrr: bill.mrr, totalSpend: bill.totalSpend, subscription: bill.subscription?.status ?? null,
      nextCharge: bill.subscription?.nextCharge && Date.parse(bill.subscription.nextCharge) > now ? day(bill.subscription.nextCharge) : null,
      collectionPaused: bill.subscription?.collectionPaused ?? null, outstanding: bill.outstanding ?? null,
    } : null,
    introductions: {
      ...intros,
      changeVsPrevious30Pct: introTrend,
      thisBillingCycle: !stopped && cycle && cycle.delivered != null ? { ...cycle, interval: schedule?.interval ?? null, nextBilling: day(schedule?.nextBillingDate), daysToBilling } : null,
      targets,
    },
    results: {
      pipelineAllTime: Object.entries(byStage).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => ({ stage: STAGE_LABEL[k] ?? k, agents: n, sharePct: rows.length ? Math.round((n / rows.length) * 1000) / 10 : null })),
      hires, clientHealth: health ? { score: health.healthScore, scale: "0–10", hiredTotal: health.hiredTotal, lastHire: health.lastHire } : null },
    campaignsLast30Days: kc?.current ? {
      platforms: platform ?? "all",
      sent: kc.current.sent, replies: kc.current.replies, replyRatePct: pct(clientRate),
      positive: kc.current.positive ?? null, positiveRatePct: pct(kc.current.positiveRate),
      bounces: kc.current.bounces ?? null, bounceRatePct: pct(kc.current.bounceRate),
      previous30: kc.previous ? { sent: kc.previous.sent, replies: kc.previous.replies, replyRatePct: pct(kc.previous.replyRate) } : null,
      businessAverage: kb ? { replyRatePct: pct(businessRate), positiveRatePct: pct(kb.positiveRate), bounceRatePct: pct(kb.bounceRate) } : null,
      replyRateVsBusiness: vsBusiness,
      note: (kc.current.sent ?? 0) < 500 ? `Only ${kc.current.sent ?? 0} emails in the period — too few for its rates to mean anything; do not compare them with the business.` : undefined,
    } : null,
    activeCampaigns: active.map((c) => ({ name: c.name, platform: c.platform, lifetimeSent: c.emailsSent, lifetimeReplyRatePct: pct(c.replyRate), leads: c.leads, dailySendLimit: c.dailySendLimit, dailyNewLeadLimit: c.dailyNewLeadLimit })),
    weeklyTrend: weeks.map((w) => ({ weekOf: day(w.week), emails: w.emails, replies: w.replies, intros: w.intros, replyRatePct: pct(w.replyRate), partial: w.partial ?? false })),
    replyMixLast30Days: mix,
    introductionSetup: intro ? {
      introducedTo: (intro as { territories?: Array<{ person: string; covers: string[] }> }).territories
        ?.map((t) => (t.covers?.length ? `${t.person} (${t.covers.join(", ")})` : t.person)) ?? null,
      byTerritory: Array.isArray((intro as { byTerritory?: unknown }).byTerritory),
      text: (intro as { whatIsSent?: string }).whatIsSent ?? null,
    } : null,
    latestScrapes: ((scrape as { batches?: unknown[] } | null)?.batches ?? []).slice(0, 3),
    unavailable: gaps,
    sources: "Master record and portal pipeline (OS / Master Inbox), Stripe, Campaign Analytics (last 30 days vs the 30 before, business average on the same platforms), Client Health (weekly volume, billing cycle, health score), Agent Search (scrapes).",
  };
}
