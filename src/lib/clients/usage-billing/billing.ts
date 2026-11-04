import "server-only";

import { randomUUID } from "node:crypto";

import { osTable } from "@/lib/clients/os-db";

import { billableLeads, LeadSourceUnavailable, type LeadSourceFn } from "./leads.ts";
import {
  amountCents,
  BILLED_STATUSES,
  CLAIM_STALE_MS,
  dedupeLeads,
  DEFAULT_LEAD_SOURCE,
  duePeriods,
  easternDay,
  INTERESTED_ON_RECORD_FROM,
  invoiceDescription,
  LEAD_SOURCES_ALL,
  isPeriodStart,
  keysAlreadyBilled,
  lastCompletedPeriod,
  lineDescription,
  MAX_LEADS_PER_PERIOD,
  modeOf,
  parseFakeLeads,
  periodKey,
  periodLabel,
  periodOf,
  scheduledChargeAllowed,
  schedulerAllowed,
  settingsRefusal,
  leadsHash,
  shortHash,
  testBillingRefusal,
  type BillableLead,
  type Deduped,
  type EveryDays,
  type LeadSource,
  type Period,
  type PeriodStatus,
  type SettingsInput,
  type SettingsRow,
  AUTO_CHARGE_FROM_HOUR_ET, autoChargeHold, easternHour, leadKey, liveAutoChargeAllowed,
  AUTO_CHARGE_LOOK_BACK, AUTO_CHARGE_WINDOW_DAYS, autoChargeInWindow, isReopened,
} from "./model.ts";
import { usageBillingStripeKey } from "./stripe-key.ts";
import { usageStripe, UsageStripeError, type CustomerCards, type InvoiceSummary, type UsageStripe } from "./stripe.ts";

/*
 * Pay per lead — the database side and the order of things (26 Oct 2026; live
 * clients 31 Oct).
 *
 * TEST OR LIVE, per client (model.ts modeOf): a row starts as a test client,
 * billed in Stripe test mode with the test key; it becomes LIVE only through
 * connectCard, a person connecting the client's card on file in live Stripe.
 * Every function here checks that the Stripe client it is handed is of the
 * client's own mode, and every period row carries that mode (test_mode), so
 * test and live billing never meet. A live client is charged only for a period
 * that has ended, never with typed-in test leads, and either when a person
 * approves the amount (chargePeriod's `approved`) or, if someone turned automatic
 * charging on for it, by the scheduled run after its checks (chargeLiveByRun).
 *
 * ---------------------------------------------------------------------------
 * NEVER TWICE
 *
 *   1. The database: os_usage_billing_periods is UNIQUE (os_client_id,
 *      period_start, test_mode). A period is CLAIMED by moving its row from 'preview' to
 *      'draft' with a conditional update (… WHERE status = 'preview'); Postgres
 *      lets exactly one of two concurrent updates match, so with two servers,
 *      a double click or a scheduled run racing a person, one bills and the
 *      other is told it is taken.
 *   2. Stripe: every create / finalize / pay carries an Idempotency-Key built
 *      from the client and the period (model.ts periodKey), and the invoice
 *      carries the same key in its metadata. A claim that died half way (a
 *      crash, a deploy) is resumed only once it is stale (CLAIM_STALE_MS), by
 *      one process (another conditional update), with the SAME lead list and
 *      the same keys; it first looks for the period's invoice in Stripe, adds
 *      only the lines that are missing, and checks the total before charging.
 *
 * WHAT IT WRITES: only os_usage_billing_settings and os_usage_billing_periods,
 * through osTable(). The leads are only read (leads.ts).
 */

type Row = Record<string, unknown>;

export class UsageBillingError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UsageBillingError";
    this.status = status;
  }
}

export interface PeriodRow {
  id: string;
  os_client_id: string;
  period_start: string;
  period_end: string;
  test_mode: boolean;
  lead_source: string;
  lead_count: number;
  price_cents: number;
  amount_cents: number;
  leads: BillableLead[];
  status: PeriodStatus;
  stripe_invoice_id: string | null;
  stripe_invoice_number: string | null;
  hosted_invoice_url: string | null;
  note: string | null;
  error: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  charged_at: string | null;
  paid_at: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const SETTINGS_COLUMNS =
  "os_client_id, enabled, test_only, price_cents, every_days, anchor_date, lead_source, stripe_customer_id, default_payment_method_id, card_label, setup_session_id, created_by, created_at, updated_by, updated_at";

function missingTable(message: string): boolean {
  return /os_usage_billing_(settings|periods)/.test(message) && /schema cache|does not exist|Could not find/i.test(message);
}
function dbError(what: string, message: string): UsageBillingError {
  return missingTable(message)
    ? new UsageBillingError("Pay per lead needs migrations/0043_usage_billing.sql run first.", 503)
    : new UsageBillingError(`${what}: ${message}`, 502);
}

/* ------------------------------------------------------------ settings --- */

export async function loadSettings(osClientId: string): Promise<SettingsRow | null> {
  const { data, error } = await osTable("os_usage_billing_settings").select(SETTINGS_COLUMNS).eq("os_client_id", osClientId).maybeSingle();
  if (error) throw dbError("os_usage_billing_settings", error.message);
  return (data as SettingsRow | null) ?? null;
}

async function clientName(osClientId: string): Promise<string | null> {
  const { data, error } = await osTable("os_clients").select("id, name").eq("id", osClientId).maybeSingle();
  if (error) throw dbError("os_clients", error.message);
  return data ? String((data as Row).name ?? "") : null;
}

/**
 * Saves price, cadence, first day, lead source and the switch. A NEW row is
 * written test_only = true (the column's default too); an existing row's
 * test_only is never written — the OS has no way to make a client live.
 */
export async function saveSettings(osClientId: string, input: SettingsInput, by: string, now = new Date()): Promise<SettingsRow> {
  if ((await clientName(osClientId)) === null) throw new UsageBillingError("No such client.", 404);
  const fields = {
    price_cents: input.priceCents,
    every_days: input.everyDays,
    anchor_date: input.anchorDate,
    lead_source: input.leadSource,
    updated_by: by,
    updated_at: now.toISOString(),
  };
  const existing = await loadSettings(osClientId);
  // Interested replies are on record from 14 Oct 2026 only: a per-lead schedule set to start earlier would miss leads.
  const scheduleSet = !existing || existing.anchor_date !== input.anchorDate || existing.lead_source !== input.leadSource;
  if (scheduleSet && input.leadSource === "handoffs" && input.anchorDate < INTERESTED_ON_RECORD_FROM) {
    throw new UsageBillingError("Interested replies are on record from Oct 14, 2026 — the first period can't start before then.", 400);
  }
  // A live client's periods are fixed by its schedule: moving the first day, the cadence or what counts would move
  // periods already billed. The price and the switch can change.
  // …until a live period has been billed: before that, a schedule set wrongly can still be put right.
  if (existing && modeOf(existing) === "live" && (existing.every_days !== input.everyDays || existing.anchor_date !== input.anchorDate || existing.lead_source !== input.leadSource)) {
    const { data: billedLive, error } = await osTable("os_usage_billing_periods").select("id").eq("os_client_id", osClientId).eq("test_mode", false).in("status", [...BILLED_STATUSES]).limit(1);
    if (error) throw dbError("os_usage_billing_periods", error.message);
    if ((billedLive ?? []).length) throw new UsageBillingError("This client is live and has been billed: its billing schedule and what counts as a lead can't be changed (it would move periods already billed). The price can.", 409);
  }
  if (existing) {
    // A live client's automatic charging has its own action (setAutoCharge): a save never touches it. Only the mode as read:
    // a test client's form saved while someone goes live is told, and can't switch the new live client on.
    const { data: written, error } = await osTable("os_usage_billing_settings")
      .update(modeOf(existing) === "live" ? fields : { ...fields, enabled: input.enabled })
      .eq("os_client_id", osClientId).eq("test_only", existing.test_only)
      .select("os_client_id");
    if (error) throw dbError("os_usage_billing_settings", error.message);
    if (!(written ?? []).length) throw new UsageBillingError("This client changed while you were saving — reload the page. Nothing was changed.", 409);
  } else {
    const { error } = await osTable("os_usage_billing_settings").upsert(
      { os_client_id: osClientId, test_only: true, enabled: input.enabled, ...fields, created_by: by, created_at: now.toISOString() },
      { onConflict: "os_client_id", ignoreDuplicates: true },
    );
    if (error) throw dbError("os_usage_billing_settings", error.message);
  }
  const saved = await loadSettings(osClientId);
  if (!saved) throw new UsageBillingError("The settings could not be read back.", 502);
  return saved;
}

/**
 * Automatic charging on or off for a live client. Writes only the switch, and only from the state the person saw: a
 * page left open from before someone else changed it is told, never overwrites it. Charges nothing itself.
 */
export async function setAutoCharge(osClientId: string, on: boolean, by: string, now = new Date()): Promise<SettingsRow> {
  const s = await billableClient(osClientId);
  if (modeOf(s) !== "live") throw new UsageBillingError("Automatic charging is for live clients.", 409);
  if (on && (!s.stripe_customer_id || !s.default_payment_method_id)) throw new UsageBillingError("No card is connected for this client.", 409);
  const { data, error } = await osTable("os_usage_billing_settings")
    .update({ enabled: on, updated_by: by, updated_at: now.toISOString() })
    .eq("os_client_id", osClientId).eq("test_only", false).eq("enabled", !on)
    .select("os_client_id");
  if (error) throw dbError("os_usage_billing_settings", error.message);
  if (!(data ?? []).length) throw new UsageBillingError("This changed since you looked — reload the page. Nothing was changed.", 409);
  console.log(`[usage-billing] ${by} turned automatic charging ${on ? "ON" : "OFF"} for ${osClientId}`);
  return (await loadSettings(osClientId))!;
}

async function patchSettings(osClientId: string, patch: Row): Promise<void> {
  const { error } = await osTable("os_usage_billing_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("os_client_id", osClientId);
  if (error) throw dbError("os_usage_billing_settings", error.message);
}

/** The settings of a TEST client, for the test-only tools — or a refusal. */
async function testClient(osClientId: string): Promise<SettingsRow> {
  const s = await loadSettings(osClientId);
  const refusal = testBillingRefusal(s);
  if (refusal) throw new UsageBillingError(refusal, 403);
  return s!;
}

/** The settings of a client that can be billed — test or live — or a refusal. */
async function billableClient(osClientId: string): Promise<SettingsRow> {
  const s = await loadSettings(osClientId);
  const refusal = settingsRefusal(s);
  if (refusal) throw new UsageBillingError(refusal, 403);
  return s!;
}

/** The Stripe client must be of the client's own mode — a test client is never billed in live Stripe, nor the reverse. */
function sameMode(s: SettingsRow, stripe: UsageStripe): void {
  if (stripe.mode !== modeOf(s)) throw new UsageBillingError(`This client is ${modeOf(s)}; refused to use ${stripe.mode} Stripe for it.`, 500);
}

const testModeOf = (s: SettingsRow) => modeOf(s) === "test";

/* ------------------------------------------------------- card on file --- */

/** The client's Stripe TEST customer, made on first use ("ZZ Usage Test — <client>"). */
export async function ensureCustomer(osClientId: string, stripe: UsageStripe): Promise<string> {
  const s = await testClient(osClientId);
  if (s.stripe_customer_id) return s.stripe_customer_id;
  const name = (await clientName(osClientId)) ?? "client";
  const { id } = await stripe.createCustomer({ osClientId, name: `ZZ Usage Test — ${name}`, idempotencyKey: `os-usage:${osClientId}:customer` });
  // Only if still empty: two clicks get the same customer from Stripe (same key) and store it once.
  const { error } = await osTable("os_usage_billing_settings").update({ stripe_customer_id: id, updated_at: new Date().toISOString() }).eq("os_client_id", osClientId).is("stripe_customer_id", null);
  if (error) throw dbError("os_usage_billing_settings", error.message);
  return (await loadSettings(osClientId))?.stripe_customer_id ?? id;
}

/** A Stripe Checkout page (mode=setup) where the card is saved. Completed with Stripe's 4242 test card. */
export async function createSetupLink(osClientId: string, stripe: UsageStripe, origin: string): Promise<{ url: string; sessionId: string }> {
  const customerId = await ensureCustomer(osClientId, stripe);
  const back = `${origin}/roster?client=${encodeURIComponent(osClientId)}`;
  const session = await stripe.setupCheckout({ customerId, osClientId, successUrl: `${back}&usage_setup=done`, cancelUrl: `${back}&usage_setup=cancelled` });
  await patchSettings(osClientId, { setup_session_id: session.id });
  return { url: session.url, sessionId: session.id };
}

/** Reads the setup Checkout back; when it is complete, its card becomes the customer's default and is stored. */
export async function confirmSetup(osClientId: string, stripe: UsageStripe): Promise<{ saved: boolean; cardLabel: string | null; status: string | null }> {
  const s = await testClient(osClientId);
  if (!s.setup_session_id || !s.stripe_customer_id) throw new UsageBillingError("No card-setup link has been made for this client yet.", 409);
  const session = await stripe.readSetupSession(s.setup_session_id);
  if (session.customerId && session.customerId !== s.stripe_customer_id) throw new UsageBillingError("That Checkout belongs to another customer.", 409);
  if (session.status !== "complete" || !session.paymentMethodId) return { saved: false, cardLabel: s.card_label, status: session.status };
  await stripe.setDefaultPaymentMethod(s.stripe_customer_id, session.paymentMethodId);
  await patchSettings(osClientId, { default_payment_method_id: session.paymentMethodId, card_label: session.cardLabel });
  return { saved: true, cardLabel: session.cardLabel, status: session.status };
}

/*
 * A period row is of the client's mode (test_mode). Test and live periods are
 * kept apart (UNIQUE includes test_mode, and every lookup filters on it), so a
 * test charge on a real client's period can never make that period — or its
 * agents — count as already billed once the client is live.
 */

/* ------------------------------------------------------------- periods --- */

export async function listPeriods(osClientId: string, limit = 52, testMode = true): Promise<PeriodRow[]> {
  const { data, error } = await osTable("os_usage_billing_periods").select("*").eq("os_client_id", osClientId).eq("test_mode", testMode).order("period_start", { ascending: false }).limit(limit);
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return (data ?? []) as PeriodRow[];
}

async function periodRow(osClientId: string, start: string, testMode: boolean): Promise<PeriodRow | null> {
  const { data, error } = await osTable("os_usage_billing_periods").select("*").eq("os_client_id", osClientId).eq("period_start", start).eq("test_mode", testMode).maybeSingle();
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return (data as PeriodRow | null) ?? null;
}

/**
 * Which period: the one asked for (it must begin a period of this schedule
 * and not lie in the future), else the last one that has ended, else — for a
 * test, while the first period is still running — the current one. With
 * `endedOnly` (a live client) only a period that has ended: a live client is
 * never billed for a period still running.
 */
export function choosePeriod(s: Pick<SettingsRow, "anchor_date" | "every_days">, today: string, asked?: string | null, endedOnly = false): Period {
  const every = s.every_days as EveryDays;
  let p: Period | null;
  if (asked) {
    if (!isPeriodStart(s.anchor_date, every, asked)) throw new UsageBillingError(`${asked} does not begin a billing period (every ${every} days from ${s.anchor_date}).`, 400);
    if (asked > today) throw new UsageBillingError("That period has not started yet.", 400);
    p = periodOf(s.anchor_date, every, asked)!;
  } else {
    p = lastCompletedPeriod(s.anchor_date, every, today) ?? (endedOnly ? null : periodOf(s.anchor_date, every, today));
    if (!p) throw new UsageBillingError(endedOnly ? `The first period has not ended yet — it ends ${periodOf(s.anchor_date, every, today)?.end ?? s.anchor_date}.` : `The first period starts ${s.anchor_date}.`, 400);
  }
  if (endedOnly && p.end > today) throw new UsageBillingError("That period has not ended yet — a live client is billed only for a period that has ended.", 400);
  return p;
}

/** Every lead key billed for this client on any OTHER period — never billed again (model.ts keysAlreadyBilled). */
async function keysBilledElsewhere(osClientId: string, exceptStart: string, testMode: boolean): Promise<Set<string>> {
  const { data, error } = await osTable("os_usage_billing_periods").select("period_start, status, leads").eq("os_client_id", osClientId).eq("test_mode", testMode).in("status", [...BILLED_STATUSES]);
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return keysAlreadyBilled((data ?? []) as Array<{ period_start: string; status: string; leads: unknown }>, exceptStart);
}

export interface Preview {
  period: Period;
  periodKey: string;
  /** Which leads, as a short fingerprint: the screen sends it back with the approval (leadsHash). */
  leadsHash: string;
  leadSource: LeadSource | "test";
  priceCents: number;
  leads: BillableLead[];
  skipped: Deduped["skipped"];
  count: number;
  amountCents: number;
  description: string;
  lines: Array<{ description: string; amountCents: number }>;
  existing: PeriodRow | null;
}

export interface PreviewOptions {
  periodStart?: string | null;
  /** TEST CLIENTS ONLY: leads typed in instead of the lead source. */
  fakeLeads?: unknown;
  now?: Date;
  /** Tests: another lead source. */
  source?: LeadSourceFn;
}

const hasFakeLeads = (v: unknown) => v !== undefined && v !== null && v !== "";


/** What the period's invoice would be. Reads only — nothing is written anywhere. */
export async function previewPeriod(osClientId: string, s: SettingsRow, o: PreviewOptions = {}): Promise<Preview> {
  const live = modeOf(s) === "live";
  if (live && hasFakeLeads(o.fakeLeads)) throw new UsageBillingError("Fake leads are for test clients only — a live client is billed for its real leads.", 403);
  const today = easternDay(o.now ?? new Date());
  const period = choosePeriod(s, today, o.periodStart ?? null, live);
  const source = ((LEAD_SOURCES_ALL as readonly string[]).includes(s.lead_source) ? s.lead_source : DEFAULT_LEAD_SOURCE) as LeadSource;
  let raw: BillableLead[];
  if (hasFakeLeads(o.fakeLeads)) {
    const parsed = parseFakeLeads(o.fakeLeads, period);
    if ("error" in parsed) throw new UsageBillingError(parsed.error, 400);
    raw = parsed;
  } else {
    try {
      raw = await (o.source ? o.source(osClientId, period.start, period.end, { startDate: s.anchor_date }) : billableLeads(osClientId, period.start, period.end, source, { startDate: s.anchor_date }));
    } catch (e) {
      if (e instanceof LeadSourceUnavailable) throw new UsageBillingError(e.message, 503);
      throw e;
    }
  }
  const d = dedupeLeads(raw, await keysBilledElsewhere(osClientId, period.start, !live));
  if (d.billable.length > MAX_LEADS_PER_PERIOD) throw new UsageBillingError(`${d.billable.length} leads in one period is more than the ${MAX_LEADS_PER_PERIOD} allowed — check the lead source before billing.`, 409);
  const price = s.price_cents;
  // Stripe's own limit for one charge ($999,999.99): never an invoice it would move onto the customer's balance instead.
  if (amountCents(d.billable.length, price) > 99_999_999) throw new UsageBillingError("This period's amount is over Stripe's limit for one charge — check the leads before billing.", 409);
  return {
    period,
    periodKey: periodKey(osClientId, period.start),
    leadsHash: leadsHash(d.billable),
    leadSource: o.fakeLeads ? "test" : source,
    priceCents: price,
    leads: d.billable,
    skipped: d.skipped,
    count: d.billable.length,
    amountCents: amountCents(d.billable.length, price),
    description: invoiceDescription(period, d.billable.length, price, source),
    lines: d.billable.map((l) => ({ description: lineDescription(l), amountCents: price })),
    existing: await periodRow(osClientId, period.start, !live),
  };
}

/* ------------------------------------------------------------- billing --- */

export type ChargeOutcome = "paid" | "failed" | "charged" | "nothing" | "already" | "in_progress";

export interface ChargeResult {
  outcome: ChargeOutcome;
  period: Period;
  row: PeriodRow | null;
  invoice: InvoiceSummary | null;
  message: string;
}

export interface ChargeOptions extends PreviewOptions {
  stripe: UsageStripe;
  by: string;
  /**
   * What the person saw and approved on the Billing tab — required for a LIVE
   * client, checked for any client when sent. The charge goes ahead only if
   * the period, the number of leads and the amount are exactly these now —
   * anything else (a lead marked since, a price changed, another tab) is
   * refused, and they preview again.
   */
  approved?: Approved | null;
}

/**
 * What a person approved on the Billing tab: the period, how many leads and the amount — and, from the same screen,
 * the client's mode, the card and which leads (a fingerprint). A page left open from before the client went live or
 * changed its card, or a lead set that changed with the same count, is refused rather than charged.
 */
export interface Approved {
  periodStart: string;
  count: number;
  amountCents: number;
  mode?: "test" | "live";
  paymentMethodId?: string | null;
  leadsHash?: string;
}

async function updateRow(id: string, from: PeriodStatus, patch: Row, claimedAt?: string | null): Promise<PeriodRow | null> {
  let q = osTable("os_usage_billing_periods").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).eq("status", from);
  // Only while this process still holds the claim: a claim taken over (a resume) is no longer ours to move on.
  if (claimedAt !== undefined) q = claimedAt ? q.eq("claimed_at", claimedAt) : q.is("claimed_at", null);
  const { data, error } = await q.select("*");
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return ((data ?? []) as PeriodRow[])[0] ?? null;
}

/** A Stripe "no such invoice" (it was a draft, deleted — in Stripe's dashboard, or by a retry whose answer was lost). */
const missingInvoice = (e: unknown) => e instanceof UsageStripeError && e.status === 404;

/**
 * Opens a period again (31 Oct review): its invoice never took money — a draft that never matched its leads or
 * was deleted, an invoice voided in Stripe — so the period goes back to 'preview', to be previewed and charged
 * again. Its leads are free again (only billed periods hold an agent). Conditional on the row as it was read.
 */
async function reopen(row: PeriodRow, by: string, why: string, claimedAt?: string | null): Promise<PeriodRow | null> {
  return updateRow(row.id, row.status, {
    status: "preview", stripe_invoice_id: null, stripe_invoice_number: null, hosted_invoice_url: null, leads: [], lead_count: 0, amount_cents: 0,
    claimed_by: null, claimed_at: null, charged_at: null, error: null, note: `${why} — opened again by ${by}; preview and charge it again.`,
  }, claimedAt);
}

/** The period's row, created as a 'preview' if it is not there (never overwriting one that is). */
async function ensurePeriodRow(osClientId: string, s: SettingsRow, period: Period): Promise<void> {
  const { error } = await osTable("os_usage_billing_periods").upsert(
    {
      os_client_id: osClientId, period_start: period.start, period_end: period.end, test_mode: testModeOf(s), status: "preview",
      lead_source: s.lead_source, price_cents: s.price_cents, lead_count: 0, amount_cents: 0, leads: [],
    },
    { onConflict: "os_client_id,period_start,test_mode", ignoreDuplicates: true },
  );
  if (error) throw dbError("os_usage_billing_periods", error.message);
}

/** The scheduled run without OS_USAGE_BILLING_CHARGE: records what it WOULD bill, on a 'preview' row only. */
export async function recordPreview(osClientId: string, s: SettingsRow, period: Period, o: { now?: Date; source?: LeadSourceFn; note?: string } = {}): Promise<PeriodRow | null> {
  const p = await previewPeriod(osClientId, s, { periodStart: period.start, now: o.now, source: o.source });
  await ensurePeriodRow(osClientId, s, period);
  const { data, error } = await osTable("os_usage_billing_periods")
    .update({
      leads: p.leads, lead_count: p.count, amount_cents: p.amountCents, price_cents: p.priceCents, lead_source: p.leadSource,
      note: isReopened(p.existing?.note) ? p.existing!.note : o.note ?? `Preview ${new Date().toISOString().slice(0, 16)}Z — not charged`, updated_at: new Date().toISOString(),
    })
    .eq("os_client_id", osClientId).eq("period_start", period.start).eq("test_mode", testModeOf(s)).eq("status", "preview")
    .select("*");
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return ((data ?? []) as PeriodRow[])[0] ?? null;
}

/**
 * Bills one period: claims it, builds the invoice (one line per lead), checks
 * it, finalizes it and charges the saved card — in the client's own mode. A
 * test client in Stripe test mode; a live client in live Stripe, and only with
 * the amount the person approved (`approved`) for a period that has ended. A
 * period already claimed is never billed again.
 */
export async function chargePeriod(osClientId: string, o: ChargeOptions): Promise<ChargeResult> {
  const s = await billableClient(osClientId);
  sameMode(s, o.stripe);
  const live = modeOf(s) === "live";
  if (live && hasFakeLeads(o.fakeLeads)) throw new UsageBillingError("Fake leads are for test clients only — a live client is billed for its real leads.", 403);
  if (!s.stripe_customer_id || !s.default_payment_method_id) throw new UsageBillingError(live ? "No card is connected for this client." : "No card is saved for this client yet — send the card-setup link first.", 409);
  if (live && (!o.approved || !o.approved.mode || !o.approved.paymentMethodId || !o.approved.leadsHash)) {
    throw new UsageBillingError("A live charge needs the amount, card and leads a person approved — preview it first.", 400);
  }
  const now = o.now ?? new Date();
  const period = choosePeriod(s, easternDay(now), o.periodStart ?? null, live);
  const changed = () => new UsageBillingError("The amount has changed since you looked (a lead was marked, or the price changed) — preview again before charging. Nothing was charged.", 409);
  // The approved amount is checked whenever it is sent (the screen always sends it); a live charge cannot go without it.
  const approved = o.approved ?? null;
  if (approved && approved.periodStart !== period.start) throw changed();
  if (approved && ((approved.mode !== undefined && approved.mode !== modeOf(s)) || (approved.paymentMethodId !== undefined && approved.paymentMethodId !== s.default_payment_method_id))) {
    throw new UsageBillingError("This client changed since you looked (it went live, or its card changed) — reload the page and preview again. Nothing was charged.", 409);
  }

  // Already claimed? Billed (or settled) periods are final; a claim that died is resumed once stale.
  const existing = await periodRow(osClientId, period.start, !live);
  if (existing && existing.status !== "preview") {
    const stale = existing.status === "draft" && (!existing.claimed_at || now.getTime() - Date.parse(existing.claimed_at) > CLAIM_STALE_MS);
    if (!stale) {
      return { outcome: existing.status === "draft" ? "in_progress" : "already", period, row: existing, invoice: null, message: alreadyMessage(existing) };
    }
    // A resume charges what was claimed: it must be what the person approved.
    if (approved && (approved.amountCents !== existing.amount_cents || approved.count !== existing.lead_count || (approved.leadsHash !== undefined && approved.leadsHash !== leadsHash(Array.isArray(existing.leads) ? existing.leads : [])))) throw changed();
    // Take over the dead claim — one process only (conditional on the claim we read).
    const take = osTable("os_usage_billing_periods")
      .update({ claimed_by: o.by, claimed_at: now.toISOString(), note: `Resumed by ${o.by}`, updated_at: now.toISOString() })
      .eq("id", existing.id).eq("status", "draft");
    const { data, error } = await (existing.claimed_at ? take.eq("claimed_at", existing.claimed_at) : take.is("claimed_at", null)).select("*");
    if (error) throw dbError("os_usage_billing_periods", error.message);
    const row = ((data ?? []) as PeriodRow[])[0];
    if (!row) return { outcome: "in_progress", period, row: existing, invoice: null, message: alreadyMessage(existing) };
    return bill(row, s, o.stripe, true);
  }

  const p = await previewPeriod(osClientId, s, o);
  if (approved && (approved.amountCents !== p.amountCents || approved.count !== p.count || (approved.leadsHash !== undefined && approved.leadsHash !== p.leadsHash))) throw changed();
  await ensurePeriodRow(osClientId, s, period);
  const claimed = await osTable("os_usage_billing_periods")
    .update({
      status: p.count ? "draft" : "void",
      leads: p.leads, lead_count: p.count, amount_cents: p.amountCents, price_cents: p.priceCents, lead_source: p.leadSource,
      claimed_by: o.by, claimed_at: now.toISOString(), error: null,
      note: p.count ? null : "No billable leads in this period — nothing charged.",
      updated_at: now.toISOString(),
    })
    .eq("os_client_id", osClientId).eq("period_start", period.start).eq("test_mode", !live).eq("status", "preview")
    .select("*");
  if (claimed.error) throw dbError("os_usage_billing_periods", claimed.error.message);
  const row = ((claimed.data ?? []) as PeriodRow[])[0];
  if (!row) {
    const now2 = await periodRow(osClientId, period.start, !live);
    return { outcome: now2?.status === "draft" ? "in_progress" : "already", period, row: now2, invoice: null, message: now2 ? alreadyMessage(now2) : "Taken by another run." };
  }
  if (!p.count) return { outcome: "nothing", period, row, invoice: null, message: "No billable leads in this period — nothing charged." };
  // Two periods charged at the same moment could each have counted the same agent (each saw the other unbilled):
  // re-checked now that this one is claimed — on an overlap it lets go, nothing is sent, and a person tries again.
  const elsewhere = await keysBilledElsewhere(osClientId, period.start, !live);
  if (p.leads.some((l) => elsewhere.has(l.key))) {
    await updateRow(row.id, "draft", { status: "preview", claimed_by: null, claimed_at: null, leads: [], lead_count: 0, amount_cents: 0, note: `An agent in it was just billed in another period — opened again by ${o.by}; preview and charge it again.` }, row.claimed_at);
    throw new UsageBillingError("An agent in this period was just billed in another period — preview again before charging. Nothing was charged.", 409);
  }
  return bill(row, s, o.stripe, false);
}

function alreadyMessage(r: PeriodRow): string {
  switch (r.status) {
    case "draft": return "This period is being billed right now — try again in a few minutes.";
    case "charged": return "This period's invoice has been charged; waiting for Stripe's answer.";
    case "paid": return "This period has been billed and paid already.";
    case "failed": return "This period has been billed; the card was refused — the invoice is open: retry the charge, or the client pays it by its link.";
    case "void": return r.note ?? "This period is closed.";
    default: return "This period is taken.";
  }
}

/** The Stripe side of a claimed ('draft') row. Same keys every time, so a resume repeats nothing. */
async function bill(row: PeriodRow, s: SettingsRow, stripe: UsageStripe, resuming: boolean): Promise<ChargeResult> {
  const period: Period = { start: row.period_start, end: row.period_end };
  const key = periodKey(row.os_client_id, row.period_start);
  const leads = (Array.isArray(row.leads) ? row.leads : []) as BillableLead[];
  const customerId = s.stripe_customer_id!;
  const claim = row.claimed_at;
  const fail = async (message: string, from: PeriodStatus = "draft"): Promise<ChargeResult> => {
    const r = await updateRow(row.id, from, { status: "failed", error: message.slice(0, 1000) }, from === "draft" ? claim : undefined);
    return { outcome: "failed", period, row: r ?? row, invoice: null, message };
  };
  // Another try took this claim over (a resume after it went stale): this one stops — never a second invoice or charge.
  const takenOver = (): ChargeResult => ({ outcome: "in_progress", period, row, invoice: null, message: "Another try took over this charge — nothing more was done here." });

  try {
    // 1. The invoice: the one on the row, else (a resume) the one Stripe already has for this period, else a new draft.
    let invoiceId = row.stripe_invoice_id;
    if (!invoiceId && resuming) invoiceId = (await stripe.findPeriodInvoice(customerId, key))?.id ?? null;
    if (!invoiceId) {
      invoiceId = (await stripe.createDraftInvoice({
        customerId, paymentMethodId: s.default_payment_method_id, osClientId: row.os_client_id, period, periodKey: key,
        description: invoiceDescription(period, leads.length, row.price_cents, row.lead_source), leadCount: leads.length,
        // This claim's own key: a period opened again (its never-finished draft removed) is billed on a new invoice.
        // A resume never makes a second one — it first finds the period's invoice (on the row, or by its metadata).
        attempt: shortHash(row.claimed_at ?? row.id),
      })).invoiceId;
    }
    if (invoiceId !== row.stripe_invoice_id && !(await updateRow(row.id, "draft", { stripe_invoice_id: invoiceId }, claim))) return takenOver();

    // 2. One line per lead — only the ones not on it yet.
    let inv: InvoiceSummary;
    try {
      inv = await stripe.getInvoice(invoiceId);
    } catch (e) {
      // The period's draft is gone (deleted in Stripe): it never took money — the period opens again.
      if (!missingInvoice(e)) throw e;
      await updateRow(row.id, "draft", { status: "preview", stripe_invoice_id: null, claimed_by: null, claimed_at: null, leads: [], lead_count: 0, amount_cents: 0, note: `Its unfinished invoice is gone from Stripe (never charged) — opened again by ${row.claimed_by ?? "a person"}; preview and charge it again.` }, claim);
      return { outcome: "nothing", period, row, invoice: null, message: "This period's unfinished invoice no longer exists in Stripe — it was never charged. Preview the period again and charge it." };
    }
    // A resume after the client's Stripe customer changed: that invoice is the earlier customer's — never charged here.
    if (inv.customerId && inv.customerId !== customerId) {
      return fail(`This period's invoice ${invoiceId} is on the client's earlier Stripe customer — not charged. ${inv.status === "open" ? "The client can pay it by its link." : "Retry removes it (it was never charged) so the period can be charged again."}`);
    }
    if (inv.status === "draft") {
      const have = new Set((await stripe.invoiceLines(invoiceId)).map((l) => l.leadKey).filter(Boolean));
      for (const lead of leads) {
        if (!have.has(lead.key)) await stripe.addLeadLine({ customerId, invoiceId, periodKey: key, lead, priceCents: row.price_cents });
      }
      inv = await stripe.getInvoice(invoiceId);
    }

    // 3. Check before charging: exactly the lines and the total we previewed.
    const lines = await stripe.invoiceLines(invoiceId);
    const keys = lines.map((l) => l.leadKey);
    const want = leads.map((l) => l.key);
    if (inv.total !== row.amount_cents || lines.length !== leads.length || want.some((k) => !keys.includes(k))) {
      return fail(`The invoice in Stripe (${lines.length} lines, ${inv.total} cents) does not match the ${leads.length} leads (${row.amount_cents} cents) previewed — not charged. Invoice ${invoiceId} is left as it is.`);
    }

    // 4. Finalize — never with a balance on the customer: Stripe adds it to the next finalized invoice, so the card
    //    would be charged more (owed) or less (credit) than the amount approved (31 Oct review).
    if (inv.status === "draft") {
      const balance = await stripe.customerBalance(customerId);
      if (balance !== 0) {
        return fail(`The client's Stripe customer has a balance of ${(Math.abs(balance) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })} ${balance > 0 ? "owed" : "in credit"} — Stripe would add it to this charge, so nothing was charged. Clear the balance in Stripe, then Retry (the unfinished invoice is removed and the period opened again).`);
      }
      inv = await stripe.finalizeInvoice(invoiceId, `${key}:finalize:${invoiceId}`);
    }
    // The move to 'charged' is this process's to make — or it pays nothing.
    const charged = await updateRow(row.id, "draft", {
      status: "charged", charged_at: new Date().toISOString(), stripe_invoice_number: inv.number, hosted_invoice_url: inv.hostedUrl,
    }, claim);
    if (!charged) return takenOver();
    const from: PeriodStatus = "charged";
    // 5. The card is charged what Stripe says is due: exactly the amount approved, or nothing.
    if (inv.status === "open" && inv.amountRemaining !== row.amount_cents) {
      const r = await updateRow(row.id, from, { status: "failed", hosted_invoice_url: inv.hostedUrl, error: `Stripe would charge ${(inv.amountRemaining / 100).toFixed(2)}, not the ${(row.amount_cents / 100).toFixed(2)} approved — nothing was charged. Void invoice ${inv.number ?? invoiceId} in Stripe, press Refresh, and charge the period again.`.slice(0, 1000) });
      return { outcome: "failed", period, row: r ?? row, invoice: inv, message: `Stripe would charge ${(inv.amountRemaining / 100).toFixed(2)} instead of the ${(row.amount_cents / 100).toFixed(2)} approved, so nothing was charged.` };
    }
    if (inv.status === "open") {
      let paid: Awaited<ReturnType<UsageStripe["payInvoice"]>>;
      try {
        // The card connected now — the one the person approved (chargePeriod checked it) — and a key of its own per card.
        paid = await stripe.payInvoice(invoiceId, `${key}:pay:${invoiceId}:${shortHash(s.default_payment_method_id ?? "")}`, s.default_payment_method_id);
      } catch (e) {
        // No answer (a timeout, Stripe busy): never left 'charged' with nothing to press — 'failed', so Retry (which
        // first asks Stripe whether it went through) or Refresh settles it. Never charged twice: Stripe pays an invoice once.
        const message = e instanceof Error ? e.message : String(e);
        const r = await updateRow(row.id, from, { status: "failed", error: `Stripe did not answer the charge (${message}) — Refresh shows whether it went through; Retry charges it if it didn't.`.slice(0, 1000), hosted_invoice_url: inv.hostedUrl });
        return { outcome: "failed", period, row: r ?? row, invoice: inv, message: `Stripe did not answer the charge (${message}). Refresh the period to see whether it went through; Retry charges it if it didn't.` };
      }
      if (!paid.ok) {
        const now = await stripe.getInvoice(invoiceId).catch(() => inv);
        const r = await updateRow(row.id, from, { status: "failed", error: paid.error.slice(0, 1000), hosted_invoice_url: now.hostedUrl });
        return { outcome: "failed", period, row: r ?? row, invoice: now, message: `The card was refused: ${paid.error} The invoice is open and can be paid by its link.` };
      }
      inv = paid.invoice;
    }
    if (inv.status === "paid") {
      const r = await updateRow(row.id, from, { status: "paid", paid_at: new Date().toISOString(), stripe_invoice_number: inv.number, hosted_invoice_url: inv.hostedUrl, error: null });
      return { outcome: "paid", period, row: r ?? row, invoice: inv, message: `Charged and paid: ${leads.length} lead${leads.length === 1 ? "" : "s"}.` };
    }
    return { outcome: "charged", period, row: charged ?? row, invoice: inv, message: `Charged; Stripe says the invoice is ${inv.status}.` };
  } catch (e) {
    // Left as 'draft' (or 'charged'): the same keys make a later resume safe. Recorded for the screen.
    const message = e instanceof Error ? e.message : String(e);
    await osTable("os_usage_billing_periods").update({ error: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", row.id);
    throw new UsageBillingError(`Stripe did not finish (${message}). Nothing is charged twice: try again after ${Math.round(CLAIM_STALE_MS / 60_000)} minutes and it resumes where it stopped. If Stripe keeps refusing it the same way, remove the unfinished charge (nothing was taken), fix the cause, and charge the period again.`, 502);
  }
}

/**
 * Reads a billed period's invoice back from Stripe and records what it says:
 * paid (by the saved card, or by the client through the invoice's link after a
 * refused card), still open, or voided in Stripe. Writes only the period row.
 */
export async function refreshPeriod(osClientId: string, periodStart: string, stripe: UsageStripe): Promise<PeriodRow | null> {
  const s = await billableClient(osClientId);
  sameMode(s, stripe);
  const row = await periodRow(osClientId, periodStart, testModeOf(s));
  if (!row || !row.stripe_invoice_id || !["charged", "failed", "paid"].includes(row.status)) return row;
  let inv: InvoiceSummary;
  try {
    inv = await stripe.getInvoice(row.stripe_invoice_id);
  } catch (e) {
    // Gone from Stripe: only a draft can be deleted, and a draft never took money — a refused period opens again.
    if (missingInvoice(e) && row.status === "failed") return (await reopen(row, "Refresh", "Its unfinished invoice is gone from Stripe (never charged)")) ?? row;
    throw e;
  }
  const patch: Row = { stripe_invoice_number: inv.number, hosted_invoice_url: inv.hostedUrl };
  if (inv.status === "paid" && row.status !== "paid") Object.assign(patch, { status: "paid", paid_at: new Date().toISOString(), error: null });
  else if (inv.status === "void" && row.status !== "paid") Object.assign(patch, { status: "void", note: "Voided in Stripe." });
  // Marked uncollectible in Stripe: nothing collected — it can still be retried (Stripe takes payment on it), or voided.
  else if (inv.status === "uncollectible" && row.status === "charged") Object.assign(patch, { status: "failed", error: "Marked uncollectible in Stripe — retry the charge, or void it in Stripe." });
  // Charged, but Stripe still has it unpaid a while later: a refused payment in all but name — so it can be retried.
  // (Not within the first two minutes: that is a charge still going through.)
  else if (inv.status === "open" && row.status === "charged" && Date.now() - Date.parse(row.charged_at ?? "") > 2 * 60_000) {
    Object.assign(patch, { status: "failed", error: "Stripe says this invoice is still unpaid — retry the charge, or the client pays it by its link." });
  }
  return (await updateRow(row.id, row.status, patch)) ?? row;
}

/**
 * A refused charge, tried again (31 Oct): the period's open invoice, charged to
 * the card connected NOW (the client may have updated it). One person at a
 * time — the row moves from 'failed' to 'charged' first, with a conditional
 * update, so two clicks or two people charge once. Paid in the meantime (the
 * client paid by the link)? Recorded, nothing charged.
 */
/** What a person approved for a retry: the period's amount and leads as they saw them, the client's mode and card. */
export type RetryApproval = Pick<Approved, "amountCents" | "mode" | "paymentMethodId"> & { count?: number; leadsHash?: string };

export async function retryPeriod(osClientId: string, periodStart: string, stripe: UsageStripe, by: string, approved?: RetryApproval | null, now = new Date()): Promise<ChargeResult> {
  const s = await billableClient(osClientId);
  sameMode(s, stripe);
  if (!s.stripe_customer_id || !s.default_payment_method_id) throw new UsageBillingError("No card is connected for this client.", 409);
  // As a charge: a live retry goes with what the person saw — the amount, the leads, the mode, the card — and a page left
  // open from before a change is refused, never charged.
  if (modeOf(s) === "live" && (!approved || !approved.mode || !approved.paymentMethodId || !approved.leadsHash)) throw new UsageBillingError("A live retry needs the amount, card and leads a person approved.", 400);
  if (approved && ((approved.mode !== undefined && approved.mode !== modeOf(s)) || (approved.paymentMethodId !== undefined && approved.paymentMethodId !== s.default_payment_method_id))) {
    throw new UsageBillingError("This client changed since you looked (it went live, or its card changed) — reload the page and try again. Nothing was charged.", 409);
  }
  const row = await periodRow(osClientId, periodStart, testModeOf(s));
  const seenChanged = (r: PeriodRow) => !!approved && (approved.amountCents !== r.amount_cents || (approved.count !== undefined && approved.count !== r.lead_count) || (approved.leadsHash !== undefined && approved.leadsHash !== leadsHash(Array.isArray(r.leads) ? r.leads : [])));
  if (row?.status === "draft") {
    if (seenChanged(row)) throw new UsageBillingError("This period changed since you looked — reload the page. Nothing was charged.", 409);
    return removeUnfinished(row, s, stripe, by, now);
  }
  // A refused charge — or a period whose invoice was voided in Stripe (nothing was taken), to charge again.
  const voided = row?.status === "void" && !!row.stripe_invoice_id && row.lead_count > 0;
  if (!row || !row.stripe_invoice_id || (row.status !== "failed" && !voided)) throw new UsageBillingError("Only a charge the card refused (or an invoice voided in Stripe) can be tried again.", 409);
  if (seenChanged(row)) throw new UsageBillingError("This period changed since you looked (its amount or its leads) — reload the page. Nothing was charged.", 409);
  const period: Period = { start: row.period_start, end: row.period_end };
  const invoiceId = row.stripe_invoice_id;
  let before: InvoiceSummary;
  try {
    before = await stripe.getInvoice(invoiceId);
  } catch (e) {
    // Gone from Stripe — only a draft can be deleted, and a draft never took money: the period opens again.
    if (!missingInvoice(e)) throw e;
    const r = await reopen(row, by, "Its unfinished invoice is gone from Stripe (never charged)");
    return { outcome: "nothing", period, row: r ?? row, invoice: null, message: "That invoice no longer exists in Stripe (it was never charged). Preview the period again and charge it." };
  }
  // Never finalized (it didn't match its leads, or the customer had a balance): never charged. Removed — Stripe
  // deletes its lines with it (checked in test mode, 2 Nov) — and the period opened again.
  if (before.status === "draft") {
    await stripe.deleteDraftInvoice(invoiceId);
    const r = await reopen(row, by, "An unfinished invoice was removed (never charged)");
    return { outcome: "nothing", period, row: r ?? row, invoice: null, message: "That invoice was never finished, so it was removed (nothing was ever charged). Preview the period again and charge it." };
  }
  // Voided in Stripe: nothing was collected on it — the period opens again.
  if (before.status === "void") {
    const r = await reopen(row, by, "Its invoice was voided in Stripe (nothing collected)");
    return { outcome: "nothing", period, row: r ?? row, invoice: null, message: "That invoice was voided in Stripe (nothing was collected). Preview the period again and charge it." };
  }
  if (voided) throw new UsageBillingError(`The invoice is ${before.status} in Stripe, not voided — press Refresh.`, 409);
  if (before.status === "paid") {
    const r = await updateRow(row.id, "failed", { status: "paid", paid_at: new Date().toISOString(), stripe_invoice_number: before.number, hosted_invoice_url: before.hostedUrl, error: null });
    return { outcome: "paid", period, row: r ?? row, invoice: before, message: "Already paid in Stripe (by its link) — recorded; nothing charged." };
  }
  // Open — or marked uncollectible in Stripe, which Stripe still takes payment on.
  if (before.status !== "open" && before.status !== "uncollectible") throw new UsageBillingError(`The invoice is ${before.status} in Stripe — it cannot be charged.`, 409);
  // Billed to the client's earlier Stripe customer: a card of the customer connected now can't pay it (Stripe refuses).
  if (before.customerId && before.customerId !== s.stripe_customer_id) {
    throw new UsageBillingError("This period was billed to the client's earlier Stripe customer, so the card connected now can't pay it. The client can pay it by its pay link.", 409);
  }
  // What paying it now takes from the card is what the person sees on the screen — or nothing is charged.
  if (before.amountRemaining !== row.amount_cents) throw new UsageBillingError(`Stripe would charge ${(before.amountRemaining / 100).toFixed(2)}, not the ${(row.amount_cents / 100).toFixed(2)} on this period — nothing was charged. Void the invoice in Stripe, press Refresh, and charge the period again.`, 409);
  const claimed = await updateRow(row.id, "failed", { status: "charged", charged_at: new Date().toISOString(), note: `Retried by ${by}`, error: null });
  if (!claimed) throw new UsageBillingError("Someone is retrying this charge right now — refresh in a moment.", 409);
  // A key of its own for each attempt — the claim above makes it this attempt's alone (a key from the row's last change
  // repeated when two changes fell in the same millisecond, and Stripe refused the second card under it).
  const key = `${periodKey(osClientId, periodStart)}:retry:${invoiceId}:${randomUUID()}`;
  let paid: Awaited<ReturnType<UsageStripe["payInvoice"]>>;
  try {
    paid = await stripe.payInvoice(invoiceId, key, s.default_payment_method_id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateRow(row.id, "charged", { status: "failed", error: `Stripe did not answer the retry (${message}) — Refresh shows whether it went through.`.slice(0, 1000) });
    throw new UsageBillingError(`Stripe did not answer (${message}). Refresh the period to see whether it went through before retrying.`, 502);
  }
  if (!paid.ok) {
    const now = await stripe.getInvoice(invoiceId).catch(() => before);
    const r = await updateRow(row.id, "charged", { status: "failed", error: paid.error.slice(0, 1000), hosted_invoice_url: now.hostedUrl });
    return { outcome: "failed", period, row: r ?? row, invoice: now, message: `The card was refused again: ${paid.error}` };
  }
  const inv = paid.invoice;
  if (inv.status === "paid") {
    const r = await updateRow(row.id, "charged", { status: "paid", paid_at: new Date().toISOString(), stripe_invoice_number: inv.number, hosted_invoice_url: inv.hostedUrl, error: null });
    return { outcome: "paid", period, row: r ?? row, invoice: inv, message: "Charged and paid." };
  }
  return { outcome: "charged", period, row: claimed, invoice: inv, message: `Charged; Stripe says the invoice is ${inv.status}.` };
}

/**
 * A charge that never finished ('draft' — its claim stale), removed and its period opened again (2 Nov review): Stripe
 * refusing the same way every time (a deleted customer, a currency mismatch) would otherwise hold the period, and its
 * agents, for good. Only while nothing can have been taken: its invoice must still be a draft (deleted here), voided
 * or gone. A finalized one is resumed with "Try the charge again" instead. Charges nothing.
 */
async function removeUnfinished(row: PeriodRow, s: SettingsRow, stripe: UsageStripe, by: string, now: Date): Promise<ChargeResult> {
  const period: Period = { start: row.period_start, end: row.period_end };
  if (row.claimed_at && now.getTime() - Date.parse(row.claimed_at) <= CLAIM_STALE_MS) {
    throw new UsageBillingError("This period is being billed right now — try again in a few minutes.", 409);
  }
  const id = row.stripe_invoice_id ?? (await stripe.findPeriodInvoice(s.stripe_customer_id!, periodKey(row.os_client_id, row.period_start)))?.id ?? null;
  let inv: InvoiceSummary | null = null;
  if (id) {
    try {
      inv = await stripe.getInvoice(id);
    } catch (e) {
      if (!missingInvoice(e)) throw e;
    }
  }
  if (inv && inv.status !== "draft" && inv.status !== "void") {
    throw new UsageBillingError(`This period's invoice is already ${inv.status} in Stripe — press "Try the charge again": it picks up where it stopped. Nothing was charged now.`, 409);
  }
  // One person at a time: the stale claim is taken first (conditional on it), as a resume takes it.
  const take = osTable("os_usage_billing_periods").update({ claimed_by: by, claimed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", row.id).eq("status", "draft");
  const { data, error } = await (row.claimed_at ? take.eq("claimed_at", row.claimed_at) : take.is("claimed_at", null)).select("*");
  if (error) throw dbError("os_usage_billing_periods", error.message);
  const mine = ((data ?? []) as PeriodRow[])[0];
  if (!mine) throw new UsageBillingError("Someone is trying this charge right now — reload in a moment.", 409);
  if (inv?.status === "draft") await stripe.deleteDraftInvoice(inv.id);
  const r = await reopen(mine, by, "An unfinished charge was removed (never charged)", mine.claimed_at);
  return { outcome: "nothing", period, row: r ?? mine, invoice: null, message: "That charge never finished and nothing was taken — it was removed and the period opened again. Fix what Stripe refused (if anything), then preview and charge it." };
}

/* ------------------------------------------------------ cards on file --- */

const CUSTOMER_ID = /^cus_[A-Za-z0-9]{6,64}$/;
const PAYMENT_METHOD_ID = /^(pm|card|src)_[A-Za-z0-9]{6,64}$/;

/** These customers and their cards, as the person picks from them (at most 8, each once). Reads only. */
export async function cardOptions(stripe: UsageStripe, customerIds: ReadonlyArray<string | null | undefined>): Promise<CustomerCards[]> {
  const ids = [...new Set(customerIds.filter((id): id is string => typeof id === "string" && CUSTOMER_ID.test(id)))].slice(0, 8);
  const out: CustomerCards[] = [];
  for (const id of ids) {
    const c = await stripe.cardsOnFile(id);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Connects a card already on file in Stripe to a client (31 Oct). With the
 * TEST Stripe, a test client's test customer and card. With the LIVE Stripe,
 * the client's real customer and card — and this is the ONE way a client
 * becomes live (test_only = false); nothing sets it back. Checked in Stripe
 * first: the customer exists, the card is on it and has not expired, and no
 * other client uses that customer. Nothing is charged.
 */
export async function connectCard(osClientId: string, pick: { customerId: string; paymentMethodId: string; claimedBy?: readonly string[] }, stripe: UsageStripe, by: string, now = new Date()): Promise<SettingsRow> {
  const s = await billableClient(osClientId);
  if (modeOf(s) === "live" && stripe.mode === "test") throw new UsageBillingError("This client is live — a test card can't be connected to it.", 409);
  if (!CUSTOMER_ID.test(pick.customerId) || !PAYMENT_METHOD_ID.test(pick.paymentMethodId)) throw new UsageBillingError("Pick a customer and one of its cards.", 400);
  // Never another client's customer: on another client's pay-per-lead row, or on another client's record.
  const [others, records] = await Promise.all([
    osTable("os_usage_billing_settings").select("os_client_id").eq("stripe_customer_id", pick.customerId).neq("os_client_id", osClientId),
    osTable("os_clients").select("id, name").eq("stripe_customer_id", pick.customerId).neq("id", osClientId),
  ]);
  if (others.error) throw dbError("os_usage_billing_settings", others.error.message);
  if (records.error) throw dbError("os_clients", records.error.message);
  const owner = ((records.data ?? []) as Row[])[0];
  if ((others.data ?? []).length || owner) throw new UsageBillingError(`That Stripe customer belongs to ${owner ? String(owner.name ?? "another client") : "another client"} — not connected.`, 409);
  // And never one the Billing tab counts for another client (its link, its subscription, its name — billing-model.ts).
  if (pick.claimedBy?.length) throw new UsageBillingError(`That Stripe customer is counted for ${pick.claimedBy.join(", ")} on the Billing tab — not connected. If it is really this client's, press "Not this client" on that client's Billing tab first.`, 409);
  const customer = await stripe.cardsOnFile(pick.customerId, now);
  if (!customer) throw new UsageBillingError("That Stripe customer doesn't exist (or was deleted).", 404);
  const card = customer.cards.find((c) => c.id === pick.paymentMethodId);
  if (!card) throw new UsageBillingError("That card is not on this customer in Stripe.", 409);
  if (card.expired) throw new UsageBillingError(`That card expired (${card.expires}) — ask the client to update it in Stripe first.`, 409);
  const goingLive = stripe.mode === "live";
  const { data, error } = await osTable("os_usage_billing_settings")
    .update({
      stripe_customer_id: customer.id, default_payment_method_id: card.id, card_label: card.expires ? `${card.label} · exp ${card.expires}` : card.label,
      // Going live means charged when someone approves: a test client's "In the scheduled run" must not carry over into automatic charging.
      setup_session_id: null, ...(goingLive && s.test_only ? { test_only: false, enabled: false } : {}), updated_by: by, updated_at: now.toISOString(),
    })
    // Only the row as it was read: two people connecting at once, the second is told.
    .eq("os_client_id", osClientId).eq("test_only", s.test_only)
    .select("os_client_id");
  if (error) throw dbError("os_usage_billing_settings", error.message);
  if (!(data ?? []).length) throw new UsageBillingError("These settings changed while you were picking — reload and try again.", 409);
  console.log(`[usage-billing] ${by} connected ${customer.id} / ${card.id} (${card.label}) to ${osClientId}${goingLive ? " — the client is now LIVE" : " (test)"}`);
  return (await loadSettings(osClientId))!;
}

/* ------------------------------------------------------ scheduled run --- */

export interface RunResult {
  off?: string;
  clients: number;
  previews: number;
  charged: number;
  /** Live periods that needed a person: not charged, and they were told (the bell). */
  held: number;
  /** Live charges the card refused: one try, then a person. */
  refused: number;
  skipped: number;
  errors: string[];
}

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** The OS bell (admins only: it is money). A ref is recorded once, so a run an hour later says nothing new. It never stops a charge. */
async function tellBell(n: { kind: string; severity: "info" | "warning" | "critical"; title: string; body: string; osClientId: string; ref: string }): Promise<void> {
  const { error } = await osTable("os_notifications").upsert(
    { kind: n.kind, severity: n.severity, title: n.title, body: n.body, os_client_id: n.osClientId, ref: n.ref },
    { onConflict: "ref", ignoreDuplicates: true },
  );
  if (error) console.error(`[usage-billing] the bell couldn't be told (${n.ref}):`, error.message);
}

/** The conversations and agents that really reached this client: a real hand-off, sent, and not bounced since. */
async function deliveredToClient(osClientId: string): Promise<{ threads: Set<string>; keys: Set<string> }> {
  const out = { threads: new Set<string>(), keys: new Set<string>() };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await osTable("os_brokerage_relays")
      .select("thread_id, agent_email")
      .eq("os_client_id", osClientId).eq("kind", "handoff").eq("status", "sent").eq("practice", false)
      .order("thread_id").range(from, from + 999);
    if (error) throw dbError("os_brokerage_relays", error.message);
    const rows = (data ?? []) as Row[];
    for (const r of rows) {
      if (r.thread_id) out.threads.add(String(r.thread_id));
      if (r.agent_email) out.keys.add(leadKey(String(r.agent_email)));
    }
    if (rows.length < 1000) return out;
  }
}

/** What became of a live period, for whoever is on the bell: paid, or not collected. Anything else says nothing yet. */
async function tellChargeResult(s: SettingsRow, clientLabel: string, row: PeriodRow | null, message?: string): Promise<void> {
  if (!row) return;
  const label = periodLabel({ start: row.period_start, end: row.period_end });
  const leads = `${row.lead_count} lead${row.lead_count === 1 ? "" : "s"}`;
  if (row.status === "paid") {
    await tellBell({
      kind: "usage_charged", severity: "info", osClientId: s.os_client_id, ref: `usage_charged:${s.os_client_id}:${row.period_start}`,
      title: `${clientLabel} paid ${usd(row.amount_cents)}`,
      body: `${leads}, ${label}. The invoice is on their Billing tab.`,
    });
  } else if (row.status === "failed") {
    // Per invoice: a period opened again and refused again is news again.
    await tellBell({
      kind: "usage_charge_failed", severity: "critical", osClientId: s.os_client_id, ref: `usage_charge_failed:${s.os_client_id}:${row.period_start}:${row.stripe_invoice_id ?? "no-invoice"}`,
      title: `${clientLabel}: the ${usd(row.amount_cents)} charge didn't go through`,
      body: `${leads}, ${label}. ${(message ?? row.error ?? "").slice(0, 400)} It is not tried again by itself: open their Billing tab and press Retry, or the client pays by the invoice's link.`,
    });
  }
}

/**
 * One ended period of a LIVE client, with nobody pressing anything. The amount chargePeriod requires "a person
 * approved" is the one just counted and checked here; it refuses if the leads move in between (the next hour's run
 * looks again). Held: recorded as a preview, a person can still charge it, and the run looks again next hour. No leads:
 * nothing is closed for good unattended (a misfiled reply may yet be put right); a person can close it.
 */
async function chargeLiveByRun(s: SettingsRow, client: { name: string; status: string | null }, period: Period, earlierRefused: boolean, stripe: UsageStripe, now: Date, source: LeadSourceFn | undefined, out: RunResult): Promise<void> {
  const p = await previewPeriod(s.os_client_id, s, { periodStart: period.start, now, source });
  if (!p.count) {
    await recordPreview(s.os_client_id, s, period, { now, source, note: "No leads in this period — nothing to charge." });
    out.skipped += 1;
    return;
  }
  const hold = autoChargeHold({ clientStatus: client.status, leadSource: p.leadSource, leads: p.leads, delivered: await deliveredToClient(s.os_client_id), earlierRefused });
  if (hold) {
    await recordPreview(s.os_client_id, s, period, { now, source, note: `Not charged automatically: ${hold}. A person can charge it here.` });
    await tellBell({
      kind: "usage_charge_held", severity: "warning", osClientId: s.os_client_id, ref: `usage_charge_held:${s.os_client_id}:${period.start}:${shortHash(hold)}`,
      title: `${client.name}: ${usd(p.amountCents)} not charged automatically`,
      body: `${periodLabel(period)}: ${hold}. Nothing was charged. Open their Billing tab to check it and charge it.`,
    });
    out.held += 1;
    return;
  }
  // Stopped while this was being counted: the switch as it is now decides.
  if (!(await loadSettings(s.os_client_id))?.enabled) { out.skipped += 1; return; }
  const r = await chargePeriod(s.os_client_id, {
    stripe, by: "automatic run", periodStart: period.start, now, source,
    approved: { periodStart: period.start, count: p.count, amountCents: p.amountCents, mode: "live", paymentMethodId: s.default_payment_method_id ?? undefined, leadsHash: p.leadsHash },
  });
  if (r.outcome === "paid" || r.outcome === "charged") out.charged += 1;
  else if (r.outcome === "failed") out.refused += 1;
  else out.skipped += 1;
  await tellChargeResult(s, client.name, r.row, r.outcome === "failed" ? r.message : undefined);
}

/** A period older than automatic charging reaches, with leads and not charged: the bell says so once, and it waits for a person. */
async function tellOlderPeriod(s: SettingsRow, client: { name: string }, period: Period, now: Date, source: LeadSourceFn | undefined): Promise<void> {
  const p = await previewPeriod(s.os_client_id, s, { periodStart: period.start, now, source });
  if (!p.count) return;
  // Billed in test mode, before this client went live: that was the test, not a period anyone should charge for real.
  const tested = await periodRow(s.os_client_id, period.start, true);
  if (tested && [...BILLED_STATUSES].includes(tested.status as never)) return;
  await tellBell({
    kind: "usage_charge_missed", severity: "warning", osClientId: s.os_client_id, ref: `usage_charge_missed:${s.os_client_id}:${period.start}`,
    title: `${client.name}: ${usd(p.amountCents)} from ${periodLabel(period)} hasn't been charged`,
    body: `Automatic charging only covers a period in the ${AUTO_CHARGE_WINDOW_DAYS} days after it ends. This one waits for a person: open their Billing tab to charge it.`,
  });
}

/**
 * The scheduled run (instrumentation.ts). Does nothing unless
 * OS_USAGE_BILLING_ENABLED=1 on Railway. Then, for each ENABLED client, the
 * periods that have ended (at most two back): with OS_USAGE_BILLING_CHARGE=1
 * and a TEST key it bills TEST clients; otherwise it only records previews.
 * A LIVE client is charged here only with OS_USAGE_BILLING_LIVE_AUTO=1 as well
 * (chargeLiveByRun, 4 Nov); otherwise only by a person approving the amount on
 * the Billing tab, and the run records its previews (as live periods).
 */
export async function runUsageBilling(o: { env?: Record<string, string | undefined>; now?: Date; stripe?: UsageStripe | null; liveStripe?: () => UsageStripe; source?: LeadSourceFn } = {}): Promise<RunResult> {
  const env = o.env ?? process.env;
  const out: RunResult = { clients: 0, previews: 0, charged: 0, held: 0, refused: 0, skipped: 0, errors: [] };
  if (!schedulerAllowed(env)) return { ...out, off: "OS_USAGE_BILLING_ENABLED is not 1 on Railway" };
  let stripe: UsageStripe | null = null;
  if (scheduledChargeAllowed(env)) {
    try {
      stripe = o.stripe ?? usageStripe(usageBillingStripeKey(env));
    } catch (e) {
      out.errors.push(`charging off: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Live clients: live Stripe only. Its key is checked here, every run; no usable key, no live charge.
  let liveStripe: UsageStripe | null = null;
  let liveOff: string | null = null;
  if (liveAutoChargeAllowed(env)) {
    try {
      if (!o.liveStripe) throw new Error("the run was given no live Stripe");
      const made = o.liveStripe();
      if (made.mode !== "live") throw new Error("the run was given a test Stripe");
      liveStripe = made;
    } catch (e) {
      liveOff = e instanceof Error ? e.message : String(e);
      out.errors.push(`live charging off: ${liveOff}`);
    }
  }
  const now = o.now ?? new Date();
  const today = easternDay(now);
  const { data, error } = await osTable("os_usage_billing_settings").select(SETTINGS_COLUMNS).eq("enabled", true);
  if (error) throw dbError("os_usage_billing_settings", error.message);
  for (const s of (data ?? []) as SettingsRow[]) {
    out.clients += 1;
    // One client's failure never stops the rest.
    try {
      await runClient(s, { env, stripe, liveStripe, liveOff, now, today, source: o.source }, out);
    } catch (e) {
      out.errors.push(`${s.os_client_id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

async function runClient(s: SettingsRow, c: { env: Record<string, string | undefined>; stripe: UsageStripe | null; liveStripe: UsageStripe | null; liveOff: string | null; now: Date; today: string; source?: LeadSourceFn }, out: RunResult): Promise<void> {
  const { env, stripe, liveStripe, liveOff, now, today, source } = c;
  // Invoices charged or refused earlier: paid since (a retry, or the client through the link)?
  if (stripe && s.test_only === true) {
    const open = (await listPeriods(s.os_client_id, 8, true)).filter((r) => r.status === "charged" || r.status === "failed");
    for (const r of open) {
      try { await refreshPeriod(s.os_client_id, r.period_start, stripe); } catch (e) { out.errors.push(`${s.os_client_id} ${r.period_start} refresh: ${e instanceof Error ? e.message : e}`); }
    }
  }
  // A live client the run may charge, and its name and status for the checks and the bell.
  const auto = s.test_only === false && s.stripe_customer_id && s.default_payment_method_id ? liveStripe : null;
  let client = { name: "A client", status: null as string | null };
  if (s.test_only === false && liveAutoChargeAllowed(env)) {
    const { data: rec, error: recErr } = await osTable("os_clients").select("name, status").eq("id", s.os_client_id).maybeSingle();
    // Unread is not "not active": nothing is charged this hour, and the bell says why.
    if (recErr) {
      await tellBell({
        kind: "usage_charge_error", severity: "warning", osClientId: s.os_client_id, ref: `usage_charge_error:${s.os_client_id}:record:${today}`,
        title: "A pay-per-lead client's record couldn't be read",
        body: `${recErr.message.slice(0, 300)} Nothing was charged for it; the run looks again next hour.`,
      });
      throw dbError("os_clients", recErr.message);
    }
    client = { name: String((rec as Row | null)?.name ?? "A client"), status: (rec as Row | null)?.status ? String((rec as Row).status) : null };
    if (liveOff) {
      await tellBell({
        kind: "usage_auto_off", severity: "critical", osClientId: s.os_client_id, ref: `usage_auto_off:${s.os_client_id}:${today}`,
        title: `${client.name}: automatic charging can't run`,
        body: `${liveOff.slice(0, 300)}. Nothing is charged until this is fixed; a period can still be charged by hand on the Billing tab.`,
      });
    }
  }
  const refusedStarts: string[] = [];
  if (auto) {
    // Every open one, however old: the refused-card hold must not lift by itself.
    const { data: openRows, error: openErr } = await osTable("os_usage_billing_periods").select("*").eq("os_client_id", s.os_client_id).eq("test_mode", false).in("status", ["charged", "failed"]);
    if (openErr) throw dbError("os_usage_billing_periods", openErr.message);
    for (const r of (openRows ?? []) as PeriodRow[]) {
      try {
        await refreshPeriod(s.os_client_id, r.period_start, auto);
        // Read again: a person's Retry may have finished while Stripe was being asked.
        const row = await periodRow(s.os_client_id, r.period_start, false);
        await tellChargeResult(s, client.name, row);
        if (row?.status === "failed") refusedStarts.push(row.period_start);
      } catch (e) {
        out.errors.push(`${s.os_client_id} ${r.period_start} refresh: ${e instanceof Error ? e.message : e}`);
        // Stripe couldn't be asked: refused it stays, as far as anyone knows.
        if (r.status === "failed") refusedStarts.push(r.period_start);
      }
    }
  }
  if (settingsRefusal(s)) { out.skipped += 1; return; }
  for (const period of duePeriods(s.anchor_date, s.every_days as EveryDays, today, auto ? AUTO_CHARGE_LOOK_BACK : undefined)) {
    try {
      const existing = await periodRow(s.os_client_id, period.start, testModeOf(s));
      if (existing && existing.status !== "preview") {
        // A charge that died half way is never finished unattended: a person's press resumes it safely.
        if (auto && existing.status === "draft" && (!existing.claimed_at || now.getTime() - Date.parse(existing.claimed_at) > CLAIM_STALE_MS)) {
          await tellBell({
            kind: "usage_charge_stuck", severity: "critical", osClientId: s.os_client_id, ref: `usage_charge_stuck:${s.os_client_id}:${period.start}:${shortHash(existing.claimed_at ?? "")}`,
            title: `${client.name}: a charge didn't finish`,
            body: `${periodLabel(period)}: the charge stopped half way. Open their Billing tab and charge it again: it carries on from where it stopped and never charges twice.`,
          });
        }
        out.skipped += 1;
        continue;
      }
      const canCharge = stripe && s.test_only === true && s.stripe_customer_id && s.default_payment_method_id;
      if (canCharge) {
        const r = await chargePeriod(s.os_client_id, { stripe: stripe!, by: "scheduled run", periodStart: period.start, now, source });
        if (r.outcome === "paid" || r.outcome === "failed" || r.outcome === "charged") out.charged += 1;
        else out.skipped += 1;
      } else if (auto) {
        if (!autoChargeInWindow(period, today)) {
          // Its own catch: the run never charges these, so a failed read here is no "automatic charge couldn't run".
          await tellOlderPeriod(s, client, period, now, source).catch((e) => out.errors.push(`${s.os_client_id} ${period.start} older: ${e instanceof Error ? e.message : e}`));
          out.skipped += 1;
        } else if (easternHour(now) < AUTO_CHARGE_FROM_HOUR_ET || isReopened(existing?.note)) {
          out.skipped += 1;
        } else {
          await chargeLiveByRun(s, client, period, refusedStarts.some((start) => start < period.start), auto, now, source, out);
        }
      } else {
        await recordPreview(s.os_client_id, s, period, { now, source });
        out.previews += 1;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.errors.push(`${s.os_client_id} ${period.start}: ${message}`);
      if (auto) {
        await tellBell({
          kind: "usage_charge_error", severity: "warning", osClientId: s.os_client_id, ref: `usage_charge_error:${s.os_client_id}:${period.start}:${today}`,
          title: `${client.name}: the automatic charge couldn't run`,
          body: `${periodLabel(period)}: ${message.slice(0, 300)} If a charge had started, their Billing tab shows it; otherwise the run looks again next hour.`,
        });
      }
    }
  }
}
