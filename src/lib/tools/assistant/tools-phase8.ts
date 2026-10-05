import "server-only";

import { NextRequest } from "next/server";

import { getPerformance } from "@/lib/workspace/performance";
import { getOverview } from "@/lib/workspace/overview";
import { getAllSnapshots } from "@/lib/status/store";
import { runReconcileCheck } from "@/lib/reconcile/run";
import { getWeekly } from "@/lib/tools/client-health/weekly";
import { biweeklyRows, successRows } from "@/lib/tools/client-health/views";
import { getClientDetail } from "@/lib/tools/onboarding/client-detail";
import { openLinks } from "@/lib/clients/payment-links";
import { listOsClients } from "@/lib/clients/os-clients";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { getCorofySupabase as getAgentSearchSupabase } from "@/lib/tools/corofy/supabase";
import { getAnalyticsSupabase } from "@/lib/tools/analytics/supabase";

import { GET as kpisGET } from "@/app/api/tools/analytics/kpis/route";
import { GET as attributionGET } from "@/app/api/tools/analytics/attribution/route";
import { GET as offersGET } from "@/app/api/tools/analytics/offers/route";
import { GET as scheduleGET } from "@/app/api/tools/analytics/schedule/route";
import { GET as campaignGET } from "@/app/api/tools/analytics/campaigns/[id]/route";

import { readOnly } from "./read-only.ts";
import { matchMasterClient } from "./tools-phase7.ts";

/*
 * Phase 8 (5 Oct, "it should cover every tool"): every remaining OS screen
 * that answers a business question — Home and system status, Performance,
 * Consistency, Client Health's Bi-Weekly and Client Success, Campaign
 * Analytics' KPIs / Attribution / Copy & Offer / Schedule / one campaign,
 * one client's onboarding and payment links, the scraped agent database,
 * the inbox's conversations and templates, and recent introductions.
 *
 * Where a screen's logic lives in its API route's GET, that handler is
 * called directly (no HTTP, no copy) so the assistant and the screen can
 * never disagree. Those GETs have no session check of their own — the
 * proxy gates them — and the assistant itself is admin-only.
 */

const mi = () => readOnly(createAdminSupabase());

/** Keep a payload model-sized: arrays capped, long strings cut, deep nesting flattened. */
function trim(v: unknown, depth = 0, max = 25): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 400 ? `${v.slice(0, 400)}…` : v;
  if (Array.isArray(v)) {
    const out = v.slice(0, max).map((x) => trim(x, depth + 1, max));
    return v.length > max ? [...out, `…and ${v.length - max} more`] : out;
  }
  if (typeof v === "object") {
    if (depth > 5) return "…";
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trim(x, depth + 1, max)]));
  }
  return String(v);
}

type RouteGet = (req: NextRequest, ctx?: never) => Promise<Response>;
async function callGet(handler: RouteGet, path: string, params: Record<string, string | undefined> = {}, ctx?: unknown) {
  const url = new URL(`http://assistant.internal${path}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(new NextRequest(url), ctx);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body;
}

/** "7d" / "30d" / "90d", or an explicit from/to (YYYY-MM-DD). */
function period(a: { period?: string; from?: string; to?: string }) {
  if (a.from && a.to) return { from: a.from, to: a.to };
  const p = ["7d", "30d", "90d"].includes(a.period ?? "") ? a.period! : "30d";
  return { preset: p };
}

// ---------------------------------------------------------------------------

export async function workspaceHomeTool() {
  const [overview, snaps] = await Promise.all([getOverview(), getAllSnapshots()]);
  return trim({
    overview: (overview as { metrics?: unknown }).metrics,
    replySplit: (overview as { split?: unknown }).split,
    tools: (snaps as Array<{ tool?: string; id?: string; state?: unknown }>).map((s) => ({ tool: s.tool ?? s.id, state: s.state })),
    note: "Home's figures: the windows and deltas are as the Home page shows them.",
  });
}

export async function businessPerformanceTool() {
  const p = await getPerformance();
  // The newest 12 months, newest first (whatever order the page keeps them in).
  const months = [...p.months].sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12);
  return trim({ ...p, months }, 0, 30);
}

export async function dataConsistencyTool() {
  const r = await runReconcileCheck({ send: false, always: true });
  return { severity: r.alert.severity, summary: r.alert.title, findings: r.alert.lines, checkedAt: r.generatedAt, note: "Report only — nothing was posted or changed." };
}

export async function billingCyclesTool(o: { withinDays?: number }) {
  const w = await getWeekly();
  const rows = biweeklyRows(w.clients, new Date(w.now))
    .filter((r) => o.withinDays == null || (r.days != null && r.days <= o.withinDays))
    .sort((a, b) => (a.days ?? 999) - (b.days ?? 999));
  return {
    asOf: w.now,
    clients: rows.slice(0, 40).map((r) => ({
      client: r.client.name, nextBilling: r.billing ? r.billing.toISOString().slice(0, 10) : null, daysUntilBilling: r.days,
      introsThisCycle: r.intros, requiredThisCycle: r.required, stillOwed: r.leftCycle, carriedIn: r.snap?.cycle.carryIn ?? 0,
    })),
    note: "Client Health's Bi-Weekly view: introductions in the current billing cycle against what is due, carry included. Null required = no target or no billing schedule.",
  };
}

export async function clientSuccessTool() {
  const w = await getWeekly();
  const rows = successRows(w.clients, new Date(w.now)).sort((a, b) => (a.score ?? 99) - (b.score ?? 99));
  return {
    clients: rows.map((r) => ({ client: r.client.name, healthScore: r.score, hiredTotal: r.hiredTotal, lastHire: r.lastHireAt?.slice(0, 10) ?? null })),
    note: "Client Health's Client Success view: account health 0–10 (null = too new to score), lowest first.",
  };
}

export async function campaignKpisTool(a: { period?: string; from?: string; to?: string }) {
  return trim(await callGet(kpisGET as RouteGet, "/api/tools/analytics/kpis", period(a)));
}

export async function attributionTool(a: { period?: string; from?: string; to?: string }) {
  return trim(await callGet(attributionGET as RouteGet, "/api/tools/analytics/attribution", period(a)));
}

export async function offerPerformanceTool(a: { period?: string; from?: string; to?: string }) {
  const body = await callGet(offersGET as RouteGet, "/api/tools/analytics/offers", period(a));
  /*
   * "Which offer is best right now" got a 7-day window with nothing sent in it
   * and answered "no data" (5 Oct). When the window asked for is empty and no
   * explicit dates were given, widen it to 30 days and say so.
   */
  const sent = JSON.stringify(body).match(/"(?:sent|emailsSent|emails_sent)":\s*([1-9]\d*)/);
  if (!sent && !a.from && a.period !== "30d" && a.period !== "90d") {
    const wider = await callGet(offersGET as RouteGet, "/api/tools/analytics/offers", { preset: "30d" });
    return trim({ note: `Nothing was sent in the ${a.period ?? "requested"} window, so this is the last 30 days.`, ...(wider as object) });
  }
  return trim(body);
}

export async function sendScheduleTool() {
  return trim(await callGet(scheduleGET as RouteGet, "/api/tools/analytics/schedule"), 0, 40);
}

export async function campaignDetailTool(query: string) {
  const an = readOnly(getAnalyticsSupabase());
  type Hit = { id: string | number; name: string; platform: string; status: string };
  const { data } = await an.from("campaigns_unified").select("id, name, platform, status").ilike("name", `%${query.trim()}%`).limit(6);
  let hits = (data ?? []) as Hit[];
  /*
   * People name a campaign loosely — "the Jeff Cook Greenville campaign" for
   * "Jeff Cook Real Estate + Greenville, SC + ZF NS1 (EST)" — so when the
   * phrase itself is not in any name, every word of it must be (6 Oct).
   */
  if (!hits.length) {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !["the", "campaign", "campaigns"].includes(w));
    if (words.length) {
      let q = an.from("campaigns_unified").select("id, name, platform, status");
      for (const w of words) q = q.ilike("name", `%${w}%`);
      hits = ((await q.limit(10)).data ?? []) as Hit[];
    }
  }
  if (!hits.length) return { note: `No campaign name contains "${query}".` };
  const exact = hits.find((h) => h.name.toLowerCase() === query.trim().toLowerCase());
  // Several matches but only one still sending: that is the one meant; the rest are listed.
  const live = hits.filter((h) => ["active", "running", "in_progress"].includes(String(h.status).toLowerCase()));
  if (hits.length > 1 && !exact && live.length !== 1) {
    return { candidates: hits.map((h) => `${h.name} (${h.platform}, ${h.status})`), note: "Several campaigns match — ask which one." };
  }
  const c = exact ?? (hits.length > 1 ? live[0] : hits[0]);
  const body = await callGet(campaignGET as unknown as RouteGet, `/api/tools/analytics/campaigns/${c.id}`, {}, { params: Promise.resolve({ id: String(c.id) }) });
  const others = hits.filter((h) => h !== c).map((h) => `${h.name} (${h.platform}, ${h.status})`);
  return others.length ? { ...(trim(body, 0, 15) as object), otherMatchingCampaigns: others } : trim(body, 0, 15);
}

export async function onboardingClientTool(query: string) {
  const { match, candidates } = await matchMasterClient(query);
  if (!match) return { candidates, note: candidates.length ? "Several clients match — ask which one." : "No such client." };
  const os = (await listOsClients()).find((c) => c.id === match.id);
  const orchId = os?.links.onboarding ?? null;
  const links = await openLinks(match.id).catch(() => null);
  if (!orchId) return { client: match.name, note: "Not in Onboarding.", openPaymentLinks: links };
  const d = await getClientDetail(orchId);
  if (!d) return { client: match.name, note: "Its Onboarding record could not be read." };
  return trim({
    client: match.name,
    stage: d.stages.find((s) => (s as { id?: string }).id === d.client.stageId) ?? d.client.stageId,
    progress: d.progress,
    steps: Object.fromEntries(Object.entries(d.steps).map(([k, v]) => [d.stepLabels[k] ?? k, v])),
    leadCount: d.leadCount,
    deliveries: d.deliveries.length,
    replies: d.replies.length,
    onboardingPayment: { paid: (d.client as { paid?: boolean }).paid ?? null, paidAt: (d.client as { paidAt?: string | null }).paidAt ?? null },
    openPaymentLinks: links,
  });
}

export async function findAgentTool(query: string) {
  const q = query.trim();
  if (q.length < 3) return { note: "Give at least three characters." };
  const as = readOnly(getAgentSearchSupabase());
  const col = q.includes("@") ? "preferred_email" : /^\d{4,}$/.test(q) ? "license_number" : "full_name";
  const { data, error } = await as.from("agents")
    .select("full_name, preferred_email, preferred_phone, license_number, brand, office_name, office_city, office_state, most_transacted_city, sales_volume, closed_transactions, avg_sale_price, est_time_in_industry_raw")
    .ilike(col, `%${q}%`).limit(10);
  if (error) return { note: `The agent database could not be read: ${error.message}` };
  return { searchedBy: col, matches: data ?? [], note: "The scraped agent database (Agent Search) — every agent ever scraped, not one client's list." };
}

export async function searchConversationsTool(a: { text: string; days?: number }) {
  const text = a.text.trim();
  if (text.length < 3) return { note: "Give at least three characters to search for." };
  const since = new Date(Date.now() - Math.min(Math.max(a.days ?? 90, 1), 365) * 86_400_000).toISOString();
  const db = mi();
  const { data, error } = await db.from("messages")
    .select("thread_id, direction, sender, subject, body_text, sent_at")
    .gte("sent_at", since).ilike("body_text", `%${text}%`).order("sent_at", { ascending: false }).limit(15);
  if (error) return { note: `Search failed: ${error.message}` };
  const rows = (data ?? []) as Array<Record<string, string | null>>;
  const ids = [...new Set(rows.map((r) => r.thread_id).filter(Boolean))] as string[];
  const { data: th } = ids.length ? await db.from("threads").select("id, client_id, subject").in("id", ids) : { data: [] };
  const { data: cl } = await db.from("clients").select("id, name");
  const portal = new Map(((cl ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const thread = new Map(((th ?? []) as Array<{ id: string; client_id: string | null; subject: string | null }>).map((t) => [t.id, t]));
  return {
    matches: rows.map((r) => {
      const body = r.body_text ?? "";
      const at = body.toLowerCase().indexOf(text.toLowerCase());
      return {
        when: r.sent_at?.slice(0, 10), direction: r.direction, from: r.sender, subject: r.subject ?? thread.get(r.thread_id ?? "")?.subject,
        portal: portal.get(thread.get(r.thread_id ?? "")?.client_id ?? "") ?? null,
        excerpt: body.slice(Math.max(0, at - 120), at + 200).replace(/\s+/g, " "),
      };
    }),
    note: `Messages in the last ${a.days ?? 90} days containing "${text}", newest first (at most 15).`,
  };
}

export async function replyTemplatesTool(query?: string) {
  let q = mi().from("reply_templates").select("name, category, subject, body").order("category").order("sort_order").limit(60);
  // Name, category or subject — intro templates are named "Intro Macro - <client>".
  if (query) {
    const term = query.replace(/[%,()]/g, " ").trim();
    const intro = /intro/i.test(term) ? ",name.ilike.%intro macro%" : "";
    q = q.or(`name.ilike.%${term}%,category.ilike.%${term}%,subject.ilike.%${term}%${intro}`);
  }
  const { data } = await q;
  const rows = (data ?? []) as Array<{ name: string; category: string | null; subject: string | null; body: string | null }>;
  return { count: rows.length, templates: rows.map((t) => ({ name: t.name, category: t.category, subject: t.subject, body: query ? t.body : (t.body ?? "").slice(0, 160) })) };
}

export async function recentIntroductionsTool(a: { days?: number; client?: string }) {
  const days = Math.min(Math.max(a.days ?? 14, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const db = mi();
  const { data: cl } = await db.from("clients").select("id, name");
  const portals = (cl ?? []) as Array<{ id: string; name: string }>;
  const name = new Map(portals.map((c) => [c.id, c.name]));
  let ids: string[] | null = null;
  if (a.client) {
    const { match } = await matchMasterClient(a.client);
    const want = match ? [match.name, ...match.aliases, ...(match.portal.links ?? []).map((l) => l.name)].map((n) => n.toLowerCase()) : [a.client.toLowerCase()];
    ids = portals.filter((p) => want.includes(p.name.toLowerCase())).map((p) => p.id);
    if (!ids.length) return { note: `No portal found for "${a.client}".` };
  }
  /*
   * Counted in full, listed in part (6 Oct): it read only the newest 60, so
   * "the last 14 days" reported 60 introductions — and per-portal counts to
   * match — when there were 150. The count and per-portal tally now read
   * every row in the window (client ids only); the list stays the newest 30.
   */
  const scope = <T,>(q: T): T => (ids ? (q as unknown as { in: (c: string, v: string[]) => T }).in("client_id", ids) : q);
  // Paged: the database hands back at most 1,000 rows a request.
  const readAll = async () => {
    const out: Array<{ client_id: string | null }> = [];
    let count: number | null = null;
    for (let from = 0; from < 20_000; from += 1000) {
      const { data: page, count: c } = await scope(db.from("client_pipeline_entries").select("client_id", { count: "exact" })
        .gte("introduced_at", since).order("introduced_at", { ascending: false }).range(from, from + 999));
      count ??= c ?? null;
      out.push(...((page ?? []) as Array<{ client_id: string | null }>));
      if ((page ?? []).length < 1000) break;
    }
    return { data: out, count };
  };
  const [{ data: all, count }, { data }] = await Promise.all([
    readAll(),
    scope(db.from("client_pipeline_entries").select("client_id, lead_name, lead_email, current_brokerage, stage, introduced_at").gte("introduced_at", since).order("introduced_at", { ascending: false }).limit(30)),
  ]);
  const rows = (data ?? []) as Array<Record<string, string | null>>;
  const byClient = ((all ?? []) as Array<{ client_id: string | null }>).reduce<Record<string, number>>((m, r) => { const n = name.get(r.client_id ?? "") ?? "?"; m[n] = (m[n] ?? 0) + 1; return m; }, {});
  const sorted = Object.fromEntries(Object.entries(byClient).sort((a, b) => b[1] - a[1]));
  return {
    days, total: count ?? (all ?? []).length, byPortal: sorted,
    introductions: rows.map((r) => ({ date: r.introduced_at?.slice(0, 10), portal: name.get(r.client_id ?? ""), agent: r.lead_name, email: r.lead_email, brokerage: r.current_brokerage, stageNow: r.stage })),
    note: (count ?? 0) > rows.length ? `All ${count} are counted in total and byPortal; only the newest ${rows.length} are listed.` : undefined,
  };
}
