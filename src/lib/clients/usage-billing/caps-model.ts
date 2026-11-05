import { addDays, daysBetween, DEFAULT_LEAD_SOURCE, modeOf, type BillableLead, type SettingsRow } from "./model.ts";

/*
 * Lead and spend caps, the rules without the network (5 Nov 2026; plan approved
 * by Eddy, Slack). The database and the campaigns are caps.ts.
 *
 *   lead cap    the client's Monthly introduction target (Client Health)
 *   spend cap   optional, on the Billing tab: $1,000 at $250 a lead is 4 leads
 *   whichever is reached first applies
 *
 * "Monthly" is a 28-day window from the billing anchor (Amy, 4 Nov: "the campaign
 * would need to resume in 28 days"), so a window always starts on a billing day
 * whether the client is billed every 7 or every 14 days. Homebase, anchored
 * Oct 28, restarts Nov 25.
 */
export const CAP_WINDOW_DAYS = 28;
/** A restart queues real email, so it waits until the team is at work: 9am Eastern on the window's first day. */
export const CAP_RESTART_FROM_HOUR_ET = 9;

export interface CapWindow {
  /** First day, inclusive (YYYY-MM-DD, Eastern). */
  start: string;
  /** The next window's first day: when campaigns restart. */
  end: string;
}

/** The window holding this day, or null before the client's first day. */
export function capWindowOf(anchor: string, day: string): CapWindow | null {
  const since = daysBetween(anchor, day);
  if (!Number.isFinite(since) || since < 0) return null;
  const start = addDays(anchor, Math.floor(since / CAP_WINDOW_DAYS) * CAP_WINDOW_DAYS);
  return { start, end: addDays(start, CAP_WINDOW_DAYS) };
}

/** Nothing pauses, restarts or is held unless this is exactly "1". Otherwise the run only says what it would do. */
export function capsLive(env: Record<string, string | undefined>): boolean {
  return env.OS_LEAD_CAPS === "1";
}

/**
 * Whose cap acts: a client billed live, per hand-off. A test row is a billing experiment and most targets are goals,
 * so neither may pause a real campaign or move a real reply. A lead counted some other way has no reply to hold.
 */
export function capAppliesTo(s: Pick<SettingsRow, "test_only" | "lead_source">): boolean {
  return modeOf(s) === "live" && s.lead_source === DEFAULT_LEAD_SOURCE;
}

/** PostgREST's own codes for a table that isn't there, nothing broader: a lock on one is an error, not "none held". */
export function tableIsMissing(e: { code?: string | null }): boolean {
  return e.code === "PGRST205" || e.code === "42P01";
}

/** The same for a column. */
export function columnIsMissing(e: { code?: string | null }): boolean {
  return e.code === "PGRST204" || e.code === "42703";
}

export interface EffectiveCap {
  /** Leads allowed in a window, or null for no cap at all. */
  cap: number | null;
  leadCap: number | null;
  spendCapCents: number | null;
  /** What the spend limit buys at this client's price. */
  spendLeads: number | null;
  /** The price went up past the limit: it can't buy one lead, so it is ignored and the team is told. Never a cap of none. */
  spendInvalid: boolean;
  by: "lead" | "spend" | null;
}

/** A target of 0 or blank is no cap: most clients' targets are goals, and 0 must never read as "allowed none". */
export function effectiveCap(p: { monthlyTarget: unknown; spendCapCents: unknown; priceCents: number }): EffectiveCap {
  const t = Number(p.monthlyTarget);
  const leadCap = p.monthlyTarget !== null && p.monthlyTarget !== "" && Number.isInteger(t) && t > 0 ? t : null;
  const c = Number(p.spendCapCents);
  const spendCapCents = p.spendCapCents !== null && p.spendCapCents !== undefined && Number.isInteger(c) && c > 0 ? c : null;
  const bought = spendCapCents !== null && p.priceCents > 0 ? Math.floor(spendCapCents / p.priceCents) : null;
  const spendInvalid = bought === 0;
  const spendLeads = bought === 0 ? null : bought;
  if (leadCap === null && spendLeads === null) return { cap: null, leadCap, spendCapCents, spendLeads, spendInvalid, by: null };
  if (spendLeads === null) return { cap: leadCap, leadCap, spendCapCents, spendLeads, spendInvalid, by: "lead" };
  if (leadCap === null) return { cap: spendLeads, leadCap, spendCapCents, spendLeads, spendInvalid, by: "spend" };
  return { cap: Math.min(leadCap, spendLeads), leadCap, spendCapCents, spendLeads, spendInvalid, by: leadCap <= spendLeads ? "lead" : "spend" };
}

/** Earliest first, the same order whoever asks: two sweeps must agree on which reply was the one over. */
function inOrder(leads: readonly BillableLead[]): BillableLead[] {
  return [...leads].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Is this conversation's reply past the cap? Its place in the window decides, not the total: with a cap of 2 and
 * three replies in one sweep, the first two go and the third is held, in whichever order they are looked at. A
 * conversation that isn't a lead of this window (an agent already billed, say) uses none of the cap.
 */
export function isOverCap(leads: readonly BillableLead[], thread: string, cap: number): boolean {
  const place = inOrder(leads).findIndex((l) => l.thread === thread);
  return place >= cap;
}

/** Client statuses a cap acts on. A paused or churned client's campaigns are the lifecycle's business, and never restarted here. */
export function capActsOn(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "active" || s === "onboarding";
}

/** A spend limit as typed in dollars. It must buy at least one lead, or the client could never receive anything. */
export function parseSpendCap(v: unknown, priceCents: number): { cents: number | null } | { error: string } {
  if (v === null || v === "" || v === undefined) return { cents: null };
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  const cents = Math.round(n * 100);
  if (!Number.isFinite(n) || cents <= 0) return { error: "The spend limit must be an amount in dollars, or blank for no limit." };
  if (cents > 100_000_000) return { error: "The spend limit is too high: the most is $1,000,000." };
  if (cents < priceCents) return { error: `The spend limit is less than one lead at this client's price, so it could never receive one.` };
  return { cents };
}

export interface CapCampaign {
  platform: "instantly" | "bison";
  id: string;
  int_id?: number | null;
  name: string;
  paused_at: string;
  /** This paused it and saw it pause, or a person added it. Only these restart by themselves. */
  confirmed: boolean;
}

/** The list plus any new ones, once each, by platform and id. Whoever got there first keeps their paused_at; confirmed once is confirmed. */
export function mergeCampaigns(list: readonly CapCampaign[], more: readonly CapCampaign[]): CapCampaign[] {
  const seen = new Map(list.map((c) => [`${c.platform}:${c.id}`, c]));
  for (const c of more) {
    const had = seen.get(`${c.platform}:${c.id}`);
    seen.set(`${c.platform}:${c.id}`, had ? { ...had, confirmed: had.confirmed || c.confirmed } : c);
  }
  return [...seen.values()];
}

export function campaignsFromJson(v: unknown): CapCampaign[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const c = x as Record<string, unknown>;
    return (c?.platform === "bison" || c?.platform === "instantly") && typeof c.id === "string"
      ? [{ platform: c.platform, id: c.id, int_id: typeof c.int_id === "number" ? c.int_id : null, name: String(c.name ?? c.id), paused_at: String(c.paused_at ?? ""), confirmed: c.confirmed === true } as CapCampaign]
      : [];
  });
}
