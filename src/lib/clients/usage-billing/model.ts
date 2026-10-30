/*
 * Pay per lead — the rules, without the network (26 Oct 2026, FIRST VERSION,
 * TEST MODE ONLY).
 *
 * What the business asked for (Slack): instead of a fixed subscription, charge
 * a client per lead — e.g. $100 or $200 a lead, set per client in the OS ("5
 * leads generated → $500 billed") — every week or every 14 days (a per-client
 * choice), automatically to the card on file. The user decided: the OS builds
 * the invoice itself each period, one Stripe invoice per client per period with
 * ONE LINE PER LEAD (name + date), previewable before it is charged.
 *
 * The user, 26 Oct: "we do not want to make this live for any of the client
 * right now. we just need to build this and make a way to test this." So this
 * version is test mode only — see stripe-key.ts.
 *
 * Everything here is pure: periods, amounts, line wording, dedupe, input
 * checks and the env switches. The database is billing.ts, Stripe is
 * stripe.ts, the leads are leads.ts.
 *
 * ---------------------------------------------------------------------------
 * DAYS
 *
 * A day is a US Eastern calendar day, written YYYY-MM-DD (the convention of
 * client-health/derive.ts: date keys as strings, day arithmetic in UTC on
 * them, "today" in America/New_York). A period is [start, end) — `end` is the
 * next period's first day — so a weekly period that starts Mon 6 Oct covers
 * Mon 6 Oct to Sun 12 Oct, Eastern, and is billed from Mon 13 Oct.
 */

export type EveryDays = 7 | 14;
export const EVERY_DAYS: readonly EveryDays[] = [7, 14];

export type LeadSource = "handoffs" | "introductions" | "calls";
export const LEAD_SOURCES_ALL: readonly LeadSource[] = ["handoffs", "introductions", "calls"];
export const LEAD_SOURCE_NAMES: Record<LeadSource, string> = {
  handoffs: "Interested replies — conversations marked Interested (once per agent)",
  introductions: "Introductions in the client's portal",
  calls: "Booked calls — conversations marked Meetings Booked (once per agent)",
};
/** What one charge is for, in words: "$500 per call". */
export const LEAD_SOURCE_UNIT: Record<LeadSource, string> = { handoffs: "lead", introductions: "introduction", calls: "call" };
/*
 * A lead is each Interested reply (the client, 27 Oct; the user, 31 Oct:
 * "interested lead means count that in for payment") — 'handoffs', the name
 * kept from when it counted replies the brokerage hand-off had sent (leads.ts).
 * Each client's row also carries its own choice (lead_source).
 */
export const DEFAULT_LEAD_SOURCE: LeadSource = "handoffs";

/*
 * The products offered when a client is onboarded (the user, 26 Oct). Each is
 * a price and what is counted — nothing else is stored, so a client's product
 * is always its (lead_source, price_cents). "Per lead" follows
 * DEFAULT_LEAD_SOURCE until the client says what a lead is.
 */
export const PAY_PER_LEAD_PRODUCTS: ReadonlyArray<{ id: string; label: string; leadSource: LeadSource; priceCents: number; offered: boolean }> = [
  { id: "lead-150", label: "$150 per lead", leadSource: DEFAULT_LEAD_SOURCE, priceCents: 15_000, offered: true },
  { id: "lead-250", label: "$250 per lead", leadSource: DEFAULT_LEAD_SOURCE, priceCents: 25_000, offered: true },
  /*
   * Not offered for now (Eddy, Slack, 27 Oct: "No need to set up 1. and 2. for
   * now. Pay per lead are each interested replies") — kept so their labels
   * still read right, out of every dropdown.
   */
  { id: "call-500", label: "$500 per call", leadSource: "calls", priceCents: 50_000, offered: false },
  { id: "call-1000", label: "$1,000 per call", leadSource: "calls", priceCents: 100_000, offered: false },
  { id: "intro-5000", label: "$5,000 per introduction", leadSource: "introductions", priceCents: 500_000, offered: false },
];
/** What the dropdowns offer: per lead, a lead being each Interested reply handed over (Eddy and Amy, 27 Oct). */
export const OFFERED_PRODUCTS = PAY_PER_LEAD_PRODUCTS.filter((p) => p.offered);

/** "$500 per call" — the product's own words, or the same shape for a custom price. */
export function productLabel(leadSource: LeadSource, priceCents: number): string {
  const p = PAY_PER_LEAD_PRODUCTS.find((x) => x.leadSource === leadSource && x.priceCents === priceCents);
  if (p) return p.label;
  const dollars = (priceCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: priceCents % 100 ? 2 : 0 });
  return `${dollars} per ${LEAD_SOURCE_UNIT[leadSource] ?? "lead"}`;
}

export type PeriodStatus = "preview" | "draft" | "charged" | "paid" | "failed" | "void";
/** A period in one of these has been billed (or settled): never billed again, and its leads are never billed again. */
export const BILLED_STATUSES: readonly PeriodStatus[] = ["draft", "charged", "paid", "failed"];

export interface BillableLead {
  /** Dedupe key, e.g. the agent's email (lower-cased). One charge per key per client, ever. */
  key: string;
  name: string;
  /** ISO 8601 instant. */
  at: string;
  source: string;
}

export interface Period {
  /** First day, inclusive (YYYY-MM-DD, Eastern). */
  start: string;
  /** The next period's first day, exclusive. */
  end: string;
}

/* -------------------------------------------------------------- days --- */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;

export function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY);
}

const ET = "America/New_York";

/** The Eastern calendar day an instant falls on. */
export function easternDay(at: Date | string | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** Eastern wall time minus UTC, in minutes, at an instant (−240 in summer, −300 in winter). */
function easternOffsetMinutes(at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(at));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Math.round((Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at) / 60_000);
}

/** The instant an Eastern day begins (midnight is never skipped or doubled — the US changes clocks at 2 a.m.). */
export function easternMidnight(day: string): Date {
  const naive = Date.parse(`${day}T00:00:00Z`);
  let t = naive - easternOffsetMinutes(naive) * 60_000;
  const again = easternOffsetMinutes(t);
  t = naive - again * 60_000;
  return new Date(t);
}

/** The instants a period covers: [from, to). */
export function periodWindow(p: Period): { from: string; to: string } {
  return { from: easternMidnight(p.start).toISOString(), to: easternMidnight(p.end).toISOString() };
}

/* ----------------------------------------------------------- periods --- */

/** The period a day falls in, counted from the anchor; null before the anchor (nothing before it is ever billed). */
export function periodOf(anchor: string, every: EveryDays, day: string): Period | null {
  const d = daysBetween(anchor, day);
  if (d < 0) return null;
  const start = addDays(anchor, Math.floor(d / every) * every);
  return { start, end: addDays(start, every) };
}

/** The most recent period that has ended by `today` (Eastern), or null if the first has not ended yet. */
export function lastCompletedPeriod(anchor: string, every: EveryDays, today: string): Period | null {
  const current = periodOf(anchor, every, today);
  if (!current || current.start === anchor) return null;
  const start = addDays(current.start, -every);
  return { start, end: current.start };
}

/**
 * The periods a scheduled run looks at: the ones that have ended, newest
 * last, at most `max` of them — so a missed run (a deploy, an outage) is
 * caught up, but an anchor set far in the past never bills a year at once.
 */
export function duePeriods(anchor: string, every: EveryDays, today: string, max = 2): Period[] {
  const out: Period[] = [];
  let p = lastCompletedPeriod(anchor, every, today);
  while (p && out.length < max) {
    out.unshift(p);
    p = p.start === anchor ? null : { start: addDays(p.start, -every), end: p.start };
  }
  return out;
}

/** A day that begins a period of this schedule. */
export function isPeriodStart(anchor: string, every: EveryDays, day: string): boolean {
  const d = daysBetween(anchor, day);
  return d >= 0 && d % every === 0;
}

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmt = (day: string, long: boolean) => (long ? LONG : SHORT).format(new Date(`${day}T00:00:00Z`));

/** "Oct 6 – Oct 12, 2026" — the days a period covers (its last day, not `end`). */
export function periodLabel(p: Period): string {
  const last = addDays(p.end, -1);
  return `${fmt(p.start, p.start.slice(0, 4) !== last.slice(0, 4))} – ${fmt(last, true)}`;
}

/* ------------------------------------------------------------ amounts --- */

export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 1_000_000;
/** More leads than this in one period is not a real week — refused rather than invoiced. */
export const MAX_LEADS_PER_PERIOD = 250;

export function amountCents(leads: number, priceCents: number): number {
  if (!Number.isInteger(leads) || leads < 0) throw new Error("lead count must be a whole number, 0 or more");
  if (!Number.isInteger(priceCents) || priceCents < MIN_PRICE_CENTS || priceCents > MAX_PRICE_CENTS) throw new Error("price must be $1 to $10,000 a lead");
  return leads * priceCents;
}

export function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

const LINE_WORD: Record<string, string> = { interested: "Lead", handoff: "Lead", introduction: "Introduction", call: "Call" };

/** One invoice line: "Lead: Jordan Ellis — Oct 7, 2026" (the Eastern day it came); "Call: …" / "Introduction: …" by what was counted. */
export function lineDescription(lead: BillableLead): string {
  const name = lead.name.replace(/\s+/g, " ").trim() || lead.key;
  return `${LINE_WORD[lead.source] ?? "Lead"}: ${name.slice(0, 200)} — ${fmt(easternDay(lead.at), true)}`;
}

/** The invoice's own description: "Pay per lead · Oct 6 – Oct 12 · 2 calls × $500.00". */
export function invoiceDescription(p: Period, count: number, priceCents: number, leadSource?: LeadSource | string): string {
  const unit = LEAD_SOURCE_UNIT[leadSource as LeadSource] ?? "lead";
  return `Pay per lead · ${periodLabel(p)} · ${count} ${unit}${count === 1 ? "" : "s"} × ${usd(priceCents)}`;
}

/* ------------------------------------------------------------- dedupe --- */

export const leadKey = (k: string) => k.trim().toLowerCase();

export interface Deduped {
  billable: BillableLead[];
  skipped: Array<{ lead: BillableLead; reason: "duplicate" | "billed_before" | "no_key" }>;
}

/**
 * Once per key, ever: the first appearance in the period (by time) is billed;
 * another appearance in the same period, or a key already billed for this
 * client in an earlier period, is not.
 */
export function dedupeLeads(leads: readonly BillableLead[], billedBefore: ReadonlySet<string>): Deduped {
  const out: Deduped = { billable: [], skipped: [] };
  const seen = new Set<string>();
  for (const lead of [...leads].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const k = leadKey(lead.key ?? "");
    if (!k) { out.skipped.push({ lead, reason: "no_key" }); continue; }
    if (billedBefore.has(k)) { out.skipped.push({ lead, reason: "billed_before" }); continue; }
    if (seen.has(k)) { out.skipped.push({ lead, reason: "duplicate" }); continue; }
    seen.add(k);
    out.billable.push({ ...lead, key: k });
  }
  return out;
}

/**
 * The keys already billed for a client: every lead on its billed periods
 * OTHER than this one. "Never an agent already billed for that client in an
 * earlier period" — and, should the anchor ever move so that periods overlap,
 * not one billed in a later-starting period either.
 */
export function keysAlreadyBilled(rows: ReadonlyArray<{ period_start: string; status: string; leads: unknown }>, exceptStart: string): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.period_start === exceptStart || !(BILLED_STATUSES as readonly string[]).includes(r.status)) continue;
    for (const l of Array.isArray(r.leads) ? r.leads : []) {
      const k = typeof (l as BillableLead)?.key === "string" ? leadKey((l as BillableLead).key) : "";
      if (k) out.add(k);
    }
  }
  return out;
}

/* ------------------------------------------------------- idempotency --- */

/**
 * The key for one client's one period. Every Stripe create/finalize/pay call
 * carries an Idempotency-Key built from it, and the invoice carries it in its
 * metadata, so a retry — a second replica, a lost answer, a resumed run —
 * gets back what the first attempt made instead of making another.
 */
export function periodKey(osClientId: string, periodStart: string): string {
  return `os-usage:${osClientId}:${periodStart}`;
}

/** Which leads, as a short fingerprint (their keys, in any order) — what a person approved, checked again before a charge. */
export function leadsHash(leads: ReadonlyArray<{ key: string }>): string {
  return shortHash(leads.map((l) => l.key).sort().join("\n"));
}

/** A short, stable digest of a lead key, for its invoice item's Idempotency-Key (keys can be long emails). */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

/** A claim older than this with no invoice finished is taken to have died, and may be resumed (with the same keys). */
export const CLAIM_STALE_MS = 15 * 60_000;

/* ----------------------------------------------------- settings input --- */

export interface SettingsInput {
  priceCents: number;
  everyDays: EveryDays;
  anchorDate: string;
  leadSource: LeadSource;
  enabled: boolean;
}

/** Checks what a person typed. `price` is dollars ("100", "$150.50") or `priceCents` a whole number of cents. */
export function parseSettingsInput(body: Record<string, unknown> | null | undefined): SettingsInput | { error: string } {
  const b = body ?? {};
  let cents: number | null = null;
  if (typeof b.priceCents === "number") cents = b.priceCents;
  else if (typeof b.price === "string" || typeof b.price === "number") {
    const t = String(b.price).replace(/[$,\s]/g, "");
    cents = /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
  }
  if (cents === null || !Number.isInteger(cents) || cents < MIN_PRICE_CENTS || cents > MAX_PRICE_CENTS) {
    return { error: "Price per lead must be between $1 and $10,000." };
  }
  const every = Number(b.everyDays);
  if (every !== 7 && every !== 14) return { error: "Bill every 7 or every 14 days." };
  if (!isDay(b.anchorDate)) return { error: "Choose the first day of the first period." };
  const source = b.leadSource === undefined ? DEFAULT_LEAD_SOURCE : b.leadSource;
  if (!(LEAD_SOURCES_ALL as readonly unknown[]).includes(source)) return { error: "Lead source must be handoffs, introductions or calls." };
  return { priceCents: cents, everyDays: every, anchorDate: b.anchorDate, leadSource: source as LeadSource, enabled: b.enabled === true };
}

/**
 * Leads typed in for a TEST (the test path only — never the scheduled run):
 * [{ name, at?, key? }] or lines "Name, 2026-10-07[, key]". Each gets a key of
 * its own unless one is given, so a test can also show the dedupe.
 */
export function parseFakeLeads(input: unknown, period: Period): BillableLead[] | { error: string } {
  const raw: Array<{ name?: unknown; at?: unknown; key?: unknown }> = [];
  if (Array.isArray(input)) raw.push(...(input as Array<{ name?: unknown; at?: unknown; key?: unknown }>));
  else if (typeof input === "string") {
    for (const line of input.split(/\r?\n/)) {
      const [name, at, key] = line.split(",").map((s) => s.trim());
      if (name) raw.push({ name, at: at || undefined, key: key || undefined });
    }
  } else return { error: "Fake leads must be a list." };
  if (raw.length > MAX_LEADS_PER_PERIOD) return { error: `At most ${MAX_LEADS_PER_PERIOD} fake leads.` };
  const out: BillableLead[] = [];
  const midday = (day: string) => new Date(easternMidnight(day).getTime() + 12 * 3_600_000).toISOString();
  for (const [i, r] of raw.entries()) {
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 200) : "";
    if (!name) return { error: `Fake lead ${i + 1} has no name.` };
    let at: string;
    if (r.at === undefined || r.at === "") at = midday(period.start);
    else if (isDay(r.at)) at = midday(r.at);
    else if (typeof r.at === "string" && Number.isFinite(Date.parse(r.at))) at = new Date(r.at).toISOString();
    else return { error: `Fake lead ${i + 1}: "${String(r.at)}" is not a date.` };
    const day = easternDay(at);
    if (day < period.start || day >= period.end) return { error: `Fake lead ${i + 1} (${day}) is outside ${periodLabel(period)}.` };
    const key = typeof r.key === "string" && r.key.trim() ? r.key : `test:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${i + 1}`;
    out.push({ key: leadKey(key), name, at, source: "test" });
  }
  return out;
}

/* ------------------------------------------------------- the switches --- */

type Env = Record<string, string | undefined>;
const onRailway = (env: Env) => !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);

/** The scheduled run exists only on Railway and only with OS_USAGE_BILLING_ENABLED=1 (unset by default). */
export function schedulerAllowed(env: Env): boolean {
  return env.OS_USAGE_BILLING_ENABLED === "1" && onRailway(env) && !!env.MASTER_INBOX_SUPABASE_URL;
}

/** The scheduled run charges only with OS_USAGE_BILLING_CHARGE=1 as well; without it, it records previews. */
export function scheduledChargeAllowed(env: Env): boolean {
  return env.OS_USAGE_BILLING_CHARGE === "1";
}

export interface SettingsRow {
  os_client_id: string;
  enabled: boolean;
  test_only: boolean;
  price_cents: number;
  every_days: number;
  anchor_date: string;
  lead_source: string;
  stripe_customer_id: string | null;
  default_payment_method_id: string | null;
  card_label: string | null;
  setup_session_id: string | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_by?: string | null;
  updated_at?: string | null;
}

/*
 * TEST OR LIVE (31 Oct). Every row starts test_only = true (saveSettings, and
 * the column's default). Only billing.ts connectCard sets it false — a person
 * on the Billing tab connecting the client's card on file in LIVE Stripe — and
 * nothing sets it back. A row that is not exactly `false` is a test row.
 */
export function modeOf(row: Pick<SettingsRow, "test_only">): "test" | "live" {
  return row.test_only === false ? "live" : "test";
}

/** Why a client's settings cannot be billed at all (either mode), or null when they can. */
export function settingsRefusal(row: Pick<SettingsRow, "price_cents" | "every_days" | "anchor_date"> | null): string | null {
  if (!row) return "This client has no pay-per-lead settings — save them first (it is then a test client).";
  if (row.every_days !== 7 && row.every_days !== 14) return "The billing cadence is not 7 or 14 days.";
  if (!isDay(row.anchor_date)) return "The first billing day is missing.";
  if (!Number.isInteger(row.price_cents) || row.price_cents < MIN_PRICE_CENTS || row.price_cents > MAX_PRICE_CENTS) return "The price per lead is not set.";
  return null;
}

/**
 * Why a client may not use a TEST-only tool (a card-setup page, fake leads, a
 * test charge of a period still running), or null when it may: its settings
 * are valid and it is still a test client.
 */
export function testBillingRefusal(row: Pick<SettingsRow, "test_only" | "price_cents" | "every_days" | "anchor_date"> | null): string | null {
  const refusal = settingsRefusal(row);
  if (refusal) return refusal;
  if (row!.test_only !== true) return "This client is live — the test tools are for test clients only.";
  return null;
}
