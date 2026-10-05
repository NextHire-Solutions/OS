import "server-only";

import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { isKnownNonClient } from "@/lib/clients/roster";
import { campaignPortalView } from "@/lib/clients/campaign-portals";
import { introView } from "@/lib/clients/intro-override";
import { stripeSummaries } from "@/lib/clients/stripe-summary";
import { introContactEmails } from "@/lib/tools/master-inbox/inbox/intro-macro";
import { introSenderEmail } from "@/lib/tools/master-inbox/inbox/intro-sender";
import { loadCommissions } from "@/lib/commissions/load";
import { stripeGet } from "@/lib/commissions/stripe-payments";
import { easternDay } from "@/lib/commissions/schedule";
import { listTeamMembers } from "@/lib/identity/team-directory";
import { listSalespeople } from "@/lib/identity/salespeople";
import { createAdminSupabase } from "@/lib/supabase/admin";

import { readOnly } from "./read-only.ts";

/*
 * Phase 7 (5 Oct): the CLIENT-LEVEL record and everything built after the
 * assistant was — billing, commissions, team, introductions, portals and
 * the portal pipeline, leads. Asked on 5 Oct, it said "no revenue is stored",
 * "no paused clients" (there were 8) and quoted campaign copy as the
 * introduction; these tools are what it lacked.
 *
 * The unit here is the MASTER client (os_clients): one client, possibly
 * several portals (Properties & Estates: Boston and Florida). The older,
 * inbox-level tools count per portal. Every read reuses the function the OS
 * screens use, so the assistant and the screens agree.
 */

const mi = () => readOnly(createAdminSupabase());
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100) / 100);

async function clients(): Promise<MasterClient[]> {
  const { clients } = await getMasterClientList();
  // Demo Portal and other known non-clients are kept in the tools but never counted.
  return clients.filter((c) => !isKnownNonClient(c.name));
}

/** One master client from what the user typed: its name, an alias, or one of its portals' names. */
export async function matchMasterClient(query: string): Promise<{ match: MasterClient | null; candidates: string[] }> {
  const all = await clients();
  const q = norm(query);
  if (!q) return { match: null, candidates: [] };
  const names = (c: MasterClient) => [c.name, ...c.aliases, ...(c.portal.links ?? []).map((l) => l.name)];
  const exact = all.filter((c) => names(c).some((n) => norm(n) === q));
  if (exact.length === 1) return { match: exact[0], candidates: [] };
  const partial = (exact.length ? exact : all).filter((c) => names(c).some((n) => norm(n).includes(q) || (q.length >= 5 && q.includes(norm(n)) && norm(n).length >= 5)));
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { match: null, candidates: partial.slice(0, 8).map((c) => c.name) };
}

async function resolveOrExplain(query: string) {
  const { match, candidates } = await matchMasterClient(query);
  if (match) return { client: match, error: null };
  return {
    client: null,
    error: candidates.length
      ? { candidates, note: "Several clients match. Ask which one — do not pick." }
      : { candidates: [], note: `No client on the master record matches "${query}".` },
  };
}

// ---------------------------------------------------------------------------
// client_record
// ---------------------------------------------------------------------------

export async function clientRecordTool(query: string) {
  const r = await resolveOrExplain(query);
  if (!r.client) return r.error;
  const c = r.client;
  const contacts = [
    c.contact.name ? { name: c.contact.name, role: c.contact.role, email: c.contact.email } : null,
    ...c.contact.extra.filter((x) => x.name).map((x) => ({ name: x.name, role: x.role, email: x.email })),
  ].filter(Boolean);
  return {
    client: c.name,
    aliases: c.aliases,
    status: c.status,
    statusSince: c.statusSince,
    plan: c.plan,
    dates: {
      signUp: c.signupDate ?? "(not entered — the Stripe customer's created day is used on screen; see client_billing)",
      start: c.startDate,
      onboarding: c.onboardingDate,
      pause: c.pauseDate,
      churn: c.churnDate,
      reactivation: c.reactivationDate,
    },
    people: { salesperson: c.salesperson, accountManager: c.accountManager, sender: c.sender },
    pointOfContact: { name: c.pocName, email: c.pocEmail },
    website: c.website,
    zillowProfile: c.zillowUrl,
    markets: c.markets ? { count: c.markets.markets, mls: c.markets.mls, areas: c.markets.areas } : null,
    timezone: c.timezone,
    billingSchedule: { interval: c.billingInterval, anchorDate: c.billingAnchorDate, nextBillingDate: c.nextBillingDate, linkedToStripe: Boolean(c.stripeSubscriptionId || c.stripeCustomerId) },
    targets: { weekly: c.weeklyTarget, monthly: c.monthlyTarget },
    thisCycle: c.health?.cycle ?? null,
    portals: (c.portal.links ?? []).map((l) => ({ name: l.name, open: l.enabled, url: l.url })),
    portalPeople: { team: c.team, agents: c.agents, dncList: c.dnc },
    introducedTo: contacts,
    introductionsAllTime: c.introductions,
    lastIntroduction: c.lastIntroAt,
    customIntroduction: c.introCustom,
  };
}

// ---------------------------------------------------------------------------
// list_clients
// ---------------------------------------------------------------------------

export async function listClientsTool(f: { status?: string; accountManager?: string; salesperson?: string; plan?: string; market?: string }) {
  const all = await clients();
  const has = (v: string | null | undefined, want?: string) => !want || norm(v).includes(norm(want));
  const rows = all.filter((c) =>
    (!f.status || c.status === f.status.toLowerCase()) &&
    has(c.accountManager, f.accountManager) && has(c.salesperson, f.salesperson) && has(c.plan, f.plan) &&
    (!f.market || [...(c.markets?.mls ?? []), ...(c.markets?.areas ?? [])].some((m) => norm(m).includes(norm(f.market!)))),
  );
  const byStatus = all.reduce<Record<string, number>>((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {});
  return {
    filters: f,
    total: rows.length,
    allClientsByStatus: byStatus,
    note: "From the master client record. Demo Portal and test rows are never counted. A client with several portals is ONE client.",
    clients: rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ name: c.name, status: c.status, statusSince: c.statusSince, pausedOn: c.pauseDate, churnedOn: c.churnDate, plan: c.plan, accountManager: c.accountManager, salesperson: c.salesperson, start: c.startDate, portals: c.portal.count })),
  };
}

// ---------------------------------------------------------------------------
// Stripe: client_billing, billing_overview
// ---------------------------------------------------------------------------

type Inv = { id: string; number: string | null; status: string; created: number; due_date: number | null; total: number; amount_remaining: number; amount_paid: number; customer: string; subscription?: string | null; parent?: { subscription_details?: { subscription?: string | null } | null } | null; status_transitions?: { paid_at?: number | null } };
const invSub = (i: Inv) => i.subscription ?? i.parent?.subscription_details?.subscription ?? null;

async function stripeJson<T>(url: string): Promise<T> {
  const res = await stripeGet(url);
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !body) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
  return body;
}

async function listInvoices(params: Record<string, string>, max = 300): Promise<Inv[]> {
  const out: Inv[] = [];
  let after: string | null = null;
  while (out.length < max) {
    const q = new URLSearchParams({ ...params, limit: "100" });
    if (after) q.set("starting_after", after);
    const b = await stripeJson<{ data: Inv[]; has_more: boolean }>(`https://api.stripe.com/v1/invoices?${q}`);
    out.push(...b.data);
    if (!b.has_more || !b.data.length) break;
    after = b.data[b.data.length - 1].id;
  }
  return out;
}

const invRow = (i: Inv) => ({
  number: i.number,
  issued: easternDay(i.created * 1000),
  amount: money(i.total / 100),
  status: i.status === "open" && i.due_date && i.due_date * 1000 < Date.now() ? "past_due" : i.status,
  due: i.due_date ? easternDay(i.due_date * 1000) : null,
  outstanding: money(i.amount_remaining / 100),
  paidOn: i.status_transitions?.paid_at ? easternDay(i.status_transitions.paid_at * 1000) : null,
});

export async function clientBillingTool(query: string) {
  const r = await resolveOrExplain(query);
  if (!r.client) return r.error;
  const c = r.client;
  if (!c.stripeCustomerId && !c.stripeSubscriptionId) {
    return { client: c.name, linkedToStripe: false, note: "Not linked to Stripe, so there is no billing data. Add its Stripe subscription on the client's record." };
  }
  const { byId, failed } = await stripeSummaries([{ id: c.id, name: c.name, stripeCustomerId: c.stripeCustomerId, stripeSubscriptionId: c.stripeSubscriptionId }]);
  const s = byId[c.id] ?? null;
  let subscription: Record<string, unknown> | null = null;
  if (c.stripeSubscriptionId) {
    const sub = await stripeJson<{ status: string; pause_collection: unknown; current_period_end?: number; items?: { data?: { current_period_end?: number }[] } }>(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(c.stripeSubscriptionId)}`);
    const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    subscription = { status: sub.status, collectionPaused: Boolean(sub.pause_collection), nextCharge: end ? easternDay(end * 1000) : null };
  }
  let invoices: ReturnType<typeof invRow>[] = [];
  const customer = c.stripeCustomerId;
  if (customer) {
    // A customer can pay for two clients (Discover Flag and Phx): keep this client's subscription and one-offs.
    const all = (await listInvoices({ customer }, 100)).filter((i) => i.status !== "draft" && (!c.stripeSubscriptionId || !invSub(i) || invSub(i) === c.stripeSubscriptionId));
    invoices = all.map(invRow);
  }
  const open = invoices.filter((i) => i.status === "open" || i.status === "past_due");
  return {
    client: c.name,
    linkedToStripe: true,
    mrr: s?.mrr ?? null,
    totalSpend: s?.totalSpend ?? null,
    successfulCharges: s?.transactions ?? null,
    stripeCustomerSince: s?.signupDate ?? null,
    subscription,
    outstanding: { invoices: open.length, amount: money(open.reduce((t, i) => t + (i.outstanding ?? 0), 0)), pastDue: open.filter((i) => i.status === "past_due").length },
    recentInvoices: invoices.slice(0, 8),
    note: failed.length ? "Stripe could not be read for this client just now." :
      "MRR is Stripe's monthly figure for live subscriptions (a paused or cancelled one counts 0). Total spend = successful charges less refunds.",
  };
}

export async function billingOverviewTool() {
  const all = await clients();
  const linked = all.filter((c) => c.stripeCustomerId || c.stripeSubscriptionId);
  const { byId, failed } = await stripeSummaries(linked);
  const mrrRows = linked.map((c) => ({ client: c.name, status: c.status, mrr: byId[c.id]?.mrr ?? null, totalSpend: byId[c.id]?.totalSpend ?? null }));
  const open = await listInvoices({ status: "open" }, 300);
  // One Stripe customer can pay for two clients (Discover Flag and Phx): an invoice
  // not tied to either subscription names both rather than guessing one.
  const byCustomer = new Map<string, string[]>();
  for (const c of linked) if (c.stripeCustomerId) byCustomer.set(c.stripeCustomerId, [...(byCustomer.get(c.stripeCustomerId) ?? []), c.name]);
  const customerLabel = (id: string) => {
    const names = byCustomer.get(id);
    return names ? (names.length > 1 ? `${names.join(" / ")} (one shared Stripe customer)` : names[0]) : `(Stripe customer ${id} — not on the client record)`;
  };
  const bySub = new Map(linked.filter((c) => c.stripeSubscriptionId).map((c) => [c.stripeSubscriptionId!, c]));
  const unpaid = open.map((i) => ({ client: (invSub(i) && bySub.get(invSub(i)!)?.name) ?? customerLabel(i.customer), ...invRow(i) }))
    .sort((a, b) => (a.status === b.status ? (b.outstanding ?? 0) - (a.outstanding ?? 0) : a.status === "past_due" ? -1 : 1));
  return {
    totalMrr: money(mrrRows.reduce((t, r) => t + (r.mrr ?? 0), 0)),
    totalSpendAllTime: money(mrrRows.reduce((t, r) => t + (r.totalSpend ?? 0), 0)),
    clientsOnStripe: linked.length,
    clientsNotOnStripe: all.filter((c) => !c.stripeCustomerId && !c.stripeSubscriptionId).map((c) => c.name),
    byMrr: mrrRows.filter((r) => r.mrr != null).sort((a, b) => (b.mrr ?? 0) - (a.mrr ?? 0)),
    unpaidInvoices: { count: unpaid.length, pastDue: unpaid.filter((u) => u.status === "past_due").length, amount: money(unpaid.reduce((t, u) => t + (u.outstanding ?? 0), 0)), invoices: unpaid.slice(0, 40) },
    note: failed.length ? `Stripe could not be read for: ${failed.join(", ")}.` : "From Stripe, read live.",
  };
}

// ---------------------------------------------------------------------------
// commissions
// ---------------------------------------------------------------------------

export async function commissionsTool(o: { run?: string; person?: string }) {
  const v = await loadCommissions({ viewerEmail: "assistant@brokerstaffer.os", admin: true, run: o.run ?? null });
  const reps = v.reps.filter((r) => !o.person || norm(r.name).includes(norm(o.person)));
  const keys = new Set(reps.flatMap((r) => r.roles.map((x) => x.key)));
  return {
    payoutRun: v.run,
    runStillOpen: v.runOpen,
    rules: "Salesperson 20% or 10% (per person) of every payment after Stripe's fee (2.9% + $0.30); account manager 5% from the client's second month. Active clients only. Paid on the 1st and 15th for payments billed since the previous run.",
    people: reps.map((r) => ({ name: r.name, due: r.due, clients: r.clients, roles: r.roles.map((x) => ({ role: x.role, rate: x.rate, due: x.due, clients: x.clients })) })),
    totalDue: money(reps.reduce((t, r) => t + r.due, 0)),
    byClient: v.rows
      .map((row) => ({ client: row.name, status: row.statusLabel, monthlyGross: row.gross, monthlyNet: row.net, earnings: row.earnings.filter((e) => keys.has(e.key)).map((e) => ({ person: e.name, role: e.role, due: e.due })) }))
      .filter((row) => row.earnings.length)
      .slice(0, 40),
    clientsMissingAPerson: v.unassigned.map((u) => ({ client: u.name, missing: u.missing, accountManagerOnRecord: u.accountManager })),
    note: v.unavailable.length ? `Not read this time: ${v.unavailable.join(", ")}.` : undefined,
  };
}

// ---------------------------------------------------------------------------
// team
// ---------------------------------------------------------------------------

export async function teamTool() {
  const [members, sp, all] = await Promise.all([listTeamMembers(), listSalespeople().catch(() => ({ people: [] as { name: string; email: string | null; active: boolean; rates: { rate: number } }[] })), clients()]);
  const count = (pick: (c: MasterClient) => string | null, name: string) => all.filter((c) => c.status === "active" && norm(pick(c)).includes(norm(name.split(" ")[0]))).length;
  return {
    members: members.map((m) => ({ name: m.name, email: m.email, admin: m.admin, accountManager: m.accountManager, activeClientsManaged: m.accountManager ? count((c) => c.accountManager, m.name) : undefined })),
    salespeople: sp.people.filter((p) => p.active).map((p) => ({ name: p.name, canSignIn: Boolean(p.email), commissionRate: p.rates.rate, activeClientsSold: count((c) => c.salesperson, p.name) })),
  };
}

// ---------------------------------------------------------------------------
// client_introduction
// ---------------------------------------------------------------------------

export async function clientIntroductionTool(query: string) {
  const r = await resolveOrExplain(query);
  if (!r.client) return r.error;
  const c = r.client;
  const v = await introView(c.id);
  const cc = introContactEmails({ name: c.name, contactName: c.contact.name, contactRole: c.contact.role, contactEmail: c.contact.email, brokerage: c.contact.brokerage, extraContacts: c.contact.extra });
  return {
    client: c.name,
    whatIsSent: v.custom ? "the client's custom introduction" : v.standard ? "the standard introduction" : "nothing — the introduction is not set up",
    text: v.custom ?? v.standard,
    missingForStandard: v.missing,
    copiedIn: cc,
    sentFrom: introSenderEmail(),
    note: "This is the introduction email the Introduce button and the reply agent send — NOT the campaign's cold email (that is campaign_copy). {{lead.*}} and {{sender.*}} are filled in per lead when it is sent.",
  };
}

// ---------------------------------------------------------------------------
// client_portals, portal_pipeline
// ---------------------------------------------------------------------------

export async function clientPortalsTool(query: string) {
  const r = await resolveOrExplain(query);
  if (!r.client) return r.error;
  const v = await campaignPortalView(r.client.id);
  const name = (id: string | null) => v.portals.find((p) => p.id === id)?.name ?? null;
  return {
    client: r.client.name,
    portals: v.portals.map((p) => ({ name: p.name, open: p.enabled, main: p.main, url: p.url })),
    campaigns: v.campaigns.map((x) => ({
      campaign: x.name, platform: x.platform, status: x.status,
      sendsLeadsTo: name(x.portalId) ?? (x.suggestion ? `${name(x.suggestion.portalId)} (automatic choice, not saved yet)` : null),
      chosen: x.source === "manual" ? `by ${x.decidedBy ?? "a person"}` : x.source === "auto" ? "automatically" : null,
    })),
    note: v.multi ? "Only NEW replies follow a campaign's portal; leads already delivered stay where they are." : "One portal: every campaign sends its leads there.",
  };
}

const STAGES = ["introduction", "phone_screen_scheduled", "phone_screen", "interview_scheduled", "interview", "hired", "keep_warm", "no_show", "we_they_rejected"] as const;

export async function portalPipelineTool(query: string, stage?: string) {
  const r = await resolveOrExplain(query);
  if (!r.client) return r.error;
  const v = await campaignPortalView(r.client.id);
  const ids = v.portals.map((p) => p.id);
  if (!ids.length) return { client: r.client.name, note: "This client has no portal." };
  const db = mi();
  const counts: Record<string, number> = {};
  await Promise.all(STAGES.map(async (s) => {
    const { count } = await db.from("client_pipeline_entries").select("id", { count: "exact", head: true }).in("client_id", ids).eq("stage", s);
    counts[s] = count ?? 0;
  }));
  let leads: unknown[] | undefined;
  // Exact stage first: "interview" must not match "interview_scheduled" (5 Oct).
  const want = stage
    ? STAGES.find((s) => norm(s) === norm(stage)) ?? STAGES.find((s) => norm(s).includes(norm(stage)) || norm(stage).includes(norm(s)))
    : undefined;
  if (want) {
    const { data } = await db.from("client_pipeline_entries").select("lead_name, lead_email, current_brokerage, introduced_at, updated_at, client_id").in("client_id", ids).eq("stage", want).order("updated_at", { ascending: false }).limit(25);
    leads = ((data ?? []) as Array<Record<string, unknown>>).map((d) => ({ name: d.lead_name, email: d.lead_email, brokerage: d.current_brokerage, introduced: String(d.introduced_at ?? "").slice(0, 10), portal: v.portals.find((p) => p.id === d.client_id)?.name }));
  }
  return {
    client: r.client.name,
    portals: v.portals.map((p) => p.name),
    byStage: counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    stage: want ?? undefined,
    leads,
    note: "All time, across every portal of this client, as the client's portal shows it today (not a period).",
  };
}

// ---------------------------------------------------------------------------
// find_lead
// ---------------------------------------------------------------------------

export async function findLeadTool(query: string) {
  const q = query.trim();
  if (q.length < 3) return { note: "Give at least three characters of an email or name." };
  const db = mi();
  const col = q.includes("@") ? "email" : "full_name";
  const { data: leads } = await db.from("leads").select("id, full_name, email, company, title, last_activity_at").ilike(col, `%${q}%`).limit(8);
  const list = (leads ?? []) as Array<Record<string, unknown>>;
  if (!list.length) return { matches: [], note: `No lead in Master Inbox matches "${q}".` };
  const ids = list.map((l) => l.id as string);
  const [threads, entries, portals] = await Promise.all([
    db.from("threads").select("lead_id, subject, last_message_at, client_id, source_provider").in("lead_id", ids).order("last_message_at", { ascending: false }).limit(30),
    db.from("client_pipeline_entries").select("lead_id, stage, client_id, introduced_at").in("lead_id", ids).limit(30),
    db.from("clients").select("id, name"),
  ]);
  const portalName = new Map(((portals.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]));
  return {
    matches: list.map((l) => ({
      name: l.full_name, email: l.email, brokerage: l.company, title: l.title, lastActivity: String(l.last_activity_at ?? "").slice(0, 10),
      conversations: ((threads.data ?? []) as Array<Record<string, unknown>>).filter((t) => t.lead_id === l.id).slice(0, 5)
        .map((t) => ({ subject: t.subject, portal: portalName.get(t.client_id as string) ?? null, platform: t.source_provider, last: String(t.last_message_at ?? "").slice(0, 10) })),
      inPortal: ((entries.data ?? []) as Array<Record<string, unknown>>).filter((e) => e.lead_id === l.id)
        .map((e) => ({ portal: portalName.get(e.client_id as string) ?? null, stage: e.stage, introduced: String(e.introduced_at ?? "").slice(0, 10) })),
    })),
  };
}
