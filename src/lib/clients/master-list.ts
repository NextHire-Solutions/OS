import "server-only";

import { analyticsRead } from "@/lib/tools/analytics/in-process";
import { billingSnapshot, dayNumber, dayToDate, scheduleFor } from "@/lib/tools/client-health/billing";
import { nextBillingDate } from "@/lib/tools/client-health/derive";
import { listClientRows } from "@/lib/tools/client-health/publish";
import { getSupabase as getHealthSupabase } from "@/lib/tools/client-health/supabase";
import type { BillingInterval } from "@/lib/tools/client-health/types";
import { loadDatabaseClients } from "@/lib/tools/database/clients";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import { loadCombinedIntroSummaryByClient } from "@/lib/tools/master-inbox/portals/intro-leads";
import { publicPortalUrl } from "@/lib/tools/master-inbox/portals/public-url";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { getOnboardingPipeline } from "@/lib/tools/onboarding/pipeline";

import type { ClientStatus } from "./client-status";
import { portalPeopleByMiId } from "./master-lookup";
import { listOsClients, type OsClient } from "./os-clients";
import { osTable } from "./os-db";
import { portalsFor, type MiPortalRow } from "./people";
import { keyOf } from "./roster";
import { EMPTY_COVERAGE, type Coverage } from "./coverage";
import { listCoverage } from "./coverage-db";
import { listClientDates, type ClientDates } from "./client-dates";

/*
 * THE MASTER CLIENT LIST — every §6 field for every client, in one read.
 *
 * The client's document, §23: "We should be able to open one system and know
 * exactly who our clients are, their current status, their plan, their
 * lifecycle dates, their billing information, their assigned team, their
 * agents, their account manager, their campaigns, their relevant operational
 * information." This is that read.
 *
 * Nothing is copied. Each value is read from the system that owns it (see
 * field-registry.ts for the owner of every field) and joined to the master
 * record by the tool link stored on `os_clients`, falling back to the name and
 * aliases for the handful of rows whose link is not yet stored.
 *
 * Every source is read independently: one tool being down blanks its own
 * columns and is named in `unavailable`, it never takes the list down. A blank
 * is `null` — "we could not look" — never a zero.
 */


export interface MasterCampaign {
  id: string;
  platform: "Instantly" | "EmailBison";
  name: string;
  /** running / paused / finished, or the platform's own word. */
  status: string | null;
  /** Leads the campaign is sized for (Client Health's campaign_size). */
  leads: number | null;
}

export interface MasterClient {
  /* Client Information */
  id: string;
  name: string;
  aliases: string[];
  status: ClientStatus;
  statusSince: string | null;
  plan: string | null;
  startDate: string | null;
  onboardingDate: string | null;
  dateAdded: string | null;
  /** §6 Market / MLS / Area, as the client data sheet has them (0022). Null when unreadable. */
  markets: Coverage | null;
  timezone: string | null;
  team: number | null;
  agents: number | null;
  dnc: number | null;
  sender: string | null;
  salesperson: string | null;
  accountManager: string | null;
  /* Billing Information */
  firstBillingDate: string | null;
  billingAnchorDate: string | null;
  billingInterval: string | null;
  billingIntervalDays: number | null;
  nextBillingDate: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /* Campaign Information */
  campaigns: MasterCampaign[] | null;
  campaignAliases: string[];
  campaignLocation: string | null;
  assignedLeads: number | null;
  /* Performance / Target Information */
  weeklyTarget: number | null;
  monthlyTarget: number | null;
  introductions: number | null;
  lastIntroAt: string | null;
  replies: number | null;
  bounces: number | null;
  sequencers: number | null;
  /** Counts where the Database has them, else yes/no from its flags. */
  inReview: number | boolean | null;
  exported: number | boolean | null;
  /* §12 lifecycle */
  pauseDate: string | null;
  churnDate: string | null;
  reactivationDate: string | null;
  /** Who introductions are addressed to, and the brokerage named (os_clients). */
  contact: OsClient["contact"];
  /* What each tool adds for its own view (§8). */
  health: {
    present: boolean;
    /** The 28-day period: delivered / target. */
    period: { delivered: number; target: number } | null;
    /** The billing cycle: delivered / required, and carry owed. */
    cycle: { delivered: number; required: number; carryIn: number } | null;
    pace: "risk" | "ok" | "done" | "pending" | null;
  };
  onboarding: { present: boolean; stage: string | null; progress: { done: number; total: number; pct: number } | null };
  portal: { count: number; url: string | null; enabled: boolean | null };
  analytics: { present: boolean; campaigns: number | null; sent: number | null };
  database: { present: boolean };
}

export interface MasterClientList {
  clients: MasterClient[];
  /** Sources that could not be read this time, by name. */
  unavailable: string[];
  loadedAt: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Finds a tool row for a client: stored link first, then name and aliases. */
function matcher<T>(rows: T[], idOf: (r: T) => string | null, nameOf: (r: T) => string | null) {
  const byId = new Map<string, T>();
  const byName = new Map<string, T>();
  for (const r of rows) {
    const id = idOf(r);
    if (id) byId.set(id, r);
    const n = nameOf(r);
    if (n && !byName.has(keyOf(n))) byName.set(keyOf(n), r);
  }
  return (c: OsClient, linked: string | null): T | undefined => {
    if (linked && byId.has(linked)) return byId.get(linked);
    for (const n of [c.name, ...c.aliases]) {
      const hit = byName.get(keyOf(n));
      if (hit) return hit;
    }
    return undefined;
  };
}

/**
 * The first billing date: the first cycle date on or after the start date.
 * Derived, never stored — the schedule is the one Client Health bills on
 * (billing.ts), so this and "Next billing date" cannot disagree.
 */
export function firstBillingDate(c: {
  start_date: string | null; billing_anchor_date: string | null;
  billing_interval: BillingInterval; billing_interval_days: number | null;
}): string | null {
  const s = scheduleFor({ ...c, monthly_target: 0, intro_dates: [] });
  const startISO = c.start_date ?? c.billing_anchor_date;
  if (!s || !startISO) return null;
  const startDay = dayNumber(startISO);
  if (!Number.isFinite(startDay)) return null;
  return iso(dayToDate(s.billingDay(s.cycleIndexOf(startDay) + 1)));
}

export interface StatusChange { from: string | null; to: string; at: string }

/**
 * §12's pause, churn and reactivation dates from the status history — the
 * LATEST of each. The seeded rows (0012: `from_status` null) record the status
 * we found, not a change on that day, so they are not counted as one.
 */
export function lifecycleDates(changes: StatusChange[]): {
  pauseDate: string | null; churnDate: string | null; reactivationDate: string | null; onboardingDate: string | null;
} {
  let pauseDate: string | null = null, churnDate: string | null = null;
  let reactivationDate: string | null = null, onboardingDate: string | null = null;
  const later = (a: string | null, b: string) => (!a || b > a ? b : a);
  const earlier = (a: string | null, b: string) => (!a || b < a ? b : a);
  for (const ch of changes) {
    if (ch.from === null) continue;
    if (ch.to === "paused") pauseDate = later(pauseDate, ch.at);
    if (ch.to === "churned") churnDate = later(churnDate, ch.at);
    if (ch.to === "active" && (ch.from === "paused" || ch.from === "churned")) reactivationDate = later(reactivationDate, ch.at);
    if (ch.to === "onboarding") onboardingDate = earlier(onboardingDate, ch.at);
  }
  return { pauseDate, churnDate, reactivationDate, onboardingDate };
}

async function readHistory(): Promise<Map<string, StatusChange[]>> {
  const { data, error } = await osTable("os_client_status_history")
    .select("os_client_id, from_status, to_status, changed_at")
    .order("changed_at", { ascending: true })
    .limit(10000);
  if (error) throw new Error(error.message);
  const out = new Map<string, StatusChange[]>();
  for (const r of (data ?? []) as unknown as { os_client_id: string; from_status: string | null; to_status: string; changed_at: string }[]) {
    const list = out.get(r.os_client_id) ?? [];
    list.push({ from: r.from_status, to: r.to_status, at: r.changed_at });
    out.set(r.os_client_id, list);
  }
  return out;
}

/** Markets / MLS / Area for every client (0022). Throws before the migration, so the list says "unreadable". */
async function readMarkets(): Promise<Map<string, Coverage>> {
  const all = await listCoverage();
  if (!all) throw new Error("Markets, MLS and Area need migration 0022.");
  return all;
}

async function readPortals(): Promise<(MiPortalRow & { portal_token: string | null })[]> {
  const { data, error } = await getMasterInboxSupabase().from("clients").select("id, name, portal_enabled, portal_token");
  if (error) throw new Error(error.message);
  return (data ?? []) as (MiPortalRow & { portal_token: string | null })[];
}

/** Client Health's campaign cache — names, statuses and sizes, without the 26 weeks of metrics. */
async function readHealthCampaigns(): Promise<Map<string, { name: string; status: string | null; size: number | null }>> {
  const sb = getHealthSupabase();
  const out = new Map<string, { name: string; status: string | null; size: number | null }>();
  for (const table of ["instantly_campaigns", "bison_campaigns"] as const) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select("id, name, status, campaign_size").range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      for (const r of (data ?? []) as Row[]) {
        out.set(String(r.id), { name: str(r.name) ?? String(r.id), status: str(r.status), size: num(r.campaign_size) });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

async function readAnalytics(): Promise<Row[]> {
  const res = await analyticsRead("/api/clients");
  if (!res.ok) throw new Error(`returned ${res.status ?? "no response"}`);
  const body = res.json as unknown;
  const rows = Array.isArray(body) ? body : (body as { clients?: unknown })?.clients;
  if (!Array.isArray(rows)) throw new Error("unexpected shape");
  return rows as Row[];
}

async function load(): Promise<MasterClientList> {
  const names = [
    "Master record", "Status history", "Markets", "Client Health", "Client Health campaigns",
    "Master Inbox portals", "Team, agents and DNC", "Introductions", "Database", "Onboarding", "Analytics",
    "Onboarding and churn dates",
  ] as const;
  const settled = await Promise.allSettled([
    listOsClients(), readHistory(), readMarkets(), listClientRows(), readHealthCampaigns(),
    readPortals(), portalPeopleByMiId(), loadCombinedIntroSummaryByClient(), loadDatabaseClients(),
    getOnboardingPipeline(), readAnalytics(),
    listClientDates().then((m) => { if (!m) throw new Error("migration 0023"); return m; }),
  ]);
  const unavailable: string[] = [];
  const get = <T,>(i: number): T | null => {
    const r = settled[i];
    if (r.status === "fulfilled") return r.value as T;
    unavailable.push(names[i]);
    return null;
  };
  const os = get<OsClient[]>(0);
  if (!os) throw new Error("The master client record could not be read.");
  const history = get<Map<string, StatusChange[]>>(1);
  const markets = get<Map<string, Coverage>>(2);
  const dates = get<Map<string, ClientDates>>(11);
  const healthRows = get<Row[]>(3);
  const healthCampaigns = get<Map<string, { name: string; status: string | null; size: number | null }>>(4);
  const portals = get<(MiPortalRow & { portal_token: string | null })[]>(5);
  const people = get<Map<string, { team: number; agents: number; dnc: number }>>(6);
  const intros = get<Map<string, { count: number; lastAt: string | null }>>(7);
  const db = get<Awaited<ReturnType<typeof loadDatabaseClients>>>(8);
  const pipeline = get<Awaited<ReturnType<typeof getOnboardingPipeline>>>(9);
  const analytics = get<Row[]>(10);

  const pickHealth = matcher(healthRows ?? [], (r) => str(r.id), (r) => str(r.name));
  const pickDb = matcher(db?.clients ?? [], (r) => r.id, (r) => r.name);
  const pickOnb = matcher((pipeline as unknown as { clients?: Row[] } | null)?.clients ?? [], (r) => str(r.id), (r) => str(r.name));
  const pickAn = matcher(analytics ?? [], (r) => str(r.id), (r) => str(r.name));
  const now = new Date();

  const clients: MasterClient[] = os.map((c) => {
    const h = pickHealth(c, c.links.clientHealth);
    const d = pickDb(c, c.links.onboarding);
    const o = pickOnb(c, c.links.onboarding);
    const a = pickAn(c, c.links.analytics);
    const changes = history?.get(c.id) ?? [];
    const life = lifecycleDates(changes);

    // Master Inbox: every portal the client has, summed (a client can run two markets).
    const mine = (portals ? portalsFor(c, portals) : []) as (MiPortalRow & { portal_token: string | null })[];
    const sum = (k: "team" | "agents" | "dnc") =>
      people && portals ? mine.reduce((n, p) => n + (people.get(p.id)?.[k] ?? 0), 0) : null;
    const introList = mine.map((p) => intros?.get(p.id)).filter(Boolean) as { count: number; lastAt: string | null }[];
    const liveToken = mine.find((p) => p.portal_token && p.portal_enabled !== false)?.portal_token ?? null;

    // Client Health
    const interval = (str(h?.billing_interval) ?? "biweekly") as BillingInterval;
    const billingIn = h ? {
      start_date: str(h.start_date), billing_anchor_date: str(h.billing_anchor_date),
      billing_interval: interval, billing_interval_days: num(h.billing_interval_days),
      monthly_target: num(h.monthly_target) ?? 0, intro_dates: strs(h.intro_dates),
    } : null;
    const snap = billingIn ? billingSnapshot(billingIn, now) : null;
    const anchor = billingIn ? billingIn.billing_anchor_date ?? billingIn.start_date : null;
    const next = billingIn && anchor ? nextBillingDate(anchor, interval, now, billingIn.billing_interval_days) : null;

    const campaignIds = h ? [...strs(h.instantly_campaign_ids).map((id) => ["Instantly", id] as const), ...strs(h.bison_campaign_ids).map((id) => ["EmailBison", id] as const)] : [];
    const campaigns: MasterCampaign[] | null = h
      ? campaignIds.map(([platform, id]) => {
          const cc = healthCampaigns?.get(id);
          return { id, platform, name: cc?.name ?? id, status: cc?.status ?? null, leads: cc?.size ?? null };
        })
      : d ? d.campaigns.map((x) => ({ id: String(x.id), platform: x.provider, name: x.name, status: x.status ?? null, leads: null }))
      : null;

    const onb = o as (Row & { progress?: { done: number; total: number; pct: number } }) | undefined;

    return {
      id: c.id,
      name: c.name,
      aliases: c.aliases,
      status: c.status,
      statusSince: changes.length ? changes[changes.length - 1].at : null,
      plan: str(h?.plan),
      startDate: str(h?.start_date),
      // Entered on the record (0023) wins; else the history; else Onboarding's call date.
      onboardingDate: dates?.get(c.id)?.onboardingDate ?? life.onboardingDate ?? str(onb?.onboardingDate),
      dateAdded: c.createdAt ?? null,
      markets: markets ? markets.get(c.id) ?? EMPTY_COVERAGE : null,
      timezone: str(h?.time_zone),
      team: sum("team"),
      agents: sum("agents"),
      dnc: sum("dnc"),
      sender: c.record.sender,
      salesperson: c.record.salesperson,
      accountManager: c.record.accountManager,

      firstBillingDate: billingIn ? firstBillingDate(billingIn) : null,
      billingAnchorDate: billingIn?.billing_anchor_date ?? null,
      billingInterval: h ? interval : null,
      billingIntervalDays: billingIn?.billing_interval_days ?? null,
      nextBillingDate: next ? iso(next) : null,
      stripeCustomerId: c.record.stripeCustomerId,
      stripeSubscriptionId: c.record.stripeSubscriptionId,

      campaigns,
      campaignAliases: c.aliases,
      campaignLocation: d?.location ?? str(onb?.mls) ?? str(onb?.location),
      assignedLeads: d ? d.leads : null,

      weeklyTarget: num(h?.weekly_target),
      monthlyTarget: num(h?.monthly_target),
      introductions: introList.length ? introList.reduce((n, x) => n + x.count, 0) : intros && portals ? 0 : null,
      lastIntroAt: introList.map((x) => x.lastAt).filter((x): x is string => !!x).sort().pop() ?? null,
      replies: d?.replied ?? null,
      bounces: d?.bounced ?? null,
      sequencers: d?.inSequencers ?? null,
      inReview: num(onb?.leadsInReview) ?? (d ? d.inReview : null),
      exported: num(onb?.leadsExported) ?? (d ? d.exported : null),

      pauseDate: life.pauseDate,
      churnDate: dates?.get(c.id)?.churnDate ?? life.churnDate,
      reactivationDate: life.reactivationDate,

      contact: c.contact,
      health: {
        present: !!h,
        period: snap && snap.period.target > 0 ? { delivered: snap.period.delivered, target: snap.period.target } : null,
        cycle: snap && snap.cycle.target > 0 ? { delivered: snap.cycle.delivered, required: snap.cycle.required, carryIn: snap.cycle.carryIn } : null,
        pace: snap && snap.period.target > 0 ? snap.status : null,
      },
      onboarding: {
        present: !!o,
        stage: str(onb?.stageName) ?? d?.stage ?? null,
        progress: onb?.progress ?? null,
      },
      portal: {
        count: mine.length,
        url: publicPortalUrl(liveToken),
        enabled: mine.length ? mine.some((p) => p.portal_enabled !== false) : null,
      },
      analytics: {
        present: !!a,
        campaigns: num(a?.campaignCount),
        sent: num(a?.sent),
      },
      database: { present: !!d },
    };
  });

  return { clients, unavailable, loadedAt: now.toISOString() };
}

/*
 * Cached for a minute and served stale for five while it refreshes: the read
 * spans six databases, and the numbers it shows move on a sync cadence, not by
 * the second. Edits invalidate it (see the clients edit route).
 */
export const getMasterClientList = ttlCache(load, { ttlMs: 60_000, staleMs: 300_000, key: () => "master-client-list", shared: "master-client-list" });
