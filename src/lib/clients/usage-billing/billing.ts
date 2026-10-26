import "server-only";

import { osTable } from "@/lib/clients/os-db";

import { billableLeads, type LeadSourceFn } from "./leads.ts";
import {
  amountCents,
  BILLED_STATUSES,
  CLAIM_STALE_MS,
  dedupeLeads,
  DEFAULT_LEAD_SOURCE,
  duePeriods,
  easternDay,
  invoiceDescription,
  isPeriodStart,
  keysAlreadyBilled,
  lastCompletedPeriod,
  lineDescription,
  MAX_LEADS_PER_PERIOD,
  parseFakeLeads,
  periodKey,
  periodOf,
  scheduledChargeAllowed,
  schedulerAllowed,
  testBillingRefusal,
  type BillableLead,
  type Deduped,
  type EveryDays,
  type LeadSource,
  type Period,
  type PeriodStatus,
  type SettingsInput,
  type SettingsRow,
} from "./model.ts";
import { usageBillingStripeKey } from "./stripe-key.ts";
import { usageStripe, type InvoiceSummary, type UsageStripe } from "./stripe.ts";

/*
 * Pay per lead — the database side and the order of things (26 Oct 2026).
 * TEST MODE ONLY: every path that reaches Stripe is handed a client built from
 * a TEST key (stripe-key.ts), and bills only a client whose settings row is
 * test_only (model.ts testBillingRefusal).
 *
 * ---------------------------------------------------------------------------
 * NEVER TWICE
 *
 *   1. The database: os_usage_billing_periods is UNIQUE (os_client_id,
 *      period_start). A period is CLAIMED by moving its row from 'preview' to
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
    enabled: input.enabled,
    price_cents: input.priceCents,
    every_days: input.everyDays,
    anchor_date: input.anchorDate,
    lead_source: input.leadSource,
    updated_by: by,
    updated_at: now.toISOString(),
  };
  const existing = await loadSettings(osClientId);
  if (existing) {
    const { error } = await osTable("os_usage_billing_settings").update(fields).eq("os_client_id", osClientId);
    if (error) throw dbError("os_usage_billing_settings", error.message);
  } else {
    const { error } = await osTable("os_usage_billing_settings").upsert(
      { os_client_id: osClientId, test_only: true, ...fields, created_by: by, created_at: now.toISOString() },
      { onConflict: "os_client_id", ignoreDuplicates: true },
    );
    if (error) throw dbError("os_usage_billing_settings", error.message);
  }
  const saved = await loadSettings(osClientId);
  if (!saved) throw new UsageBillingError("The settings could not be read back.", 502);
  return saved;
}

async function patchSettings(osClientId: string, patch: Row): Promise<void> {
  const { error } = await osTable("os_usage_billing_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("os_client_id", osClientId);
  if (error) throw dbError("os_usage_billing_settings", error.message);
}

/** The settings of a client that may be billed in TEST mode — or a refusal. */
async function testClient(osClientId: string): Promise<SettingsRow> {
  const s = await loadSettings(osClientId);
  const refusal = testBillingRefusal(s);
  if (refusal) throw new UsageBillingError(refusal, 403);
  return s!;
}

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

/* ------------------------------------------------------------- periods --- */

export async function listPeriods(osClientId: string, limit = 52): Promise<PeriodRow[]> {
  const { data, error } = await osTable("os_usage_billing_periods").select("*").eq("os_client_id", osClientId).order("period_start", { ascending: false }).limit(limit);
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return (data ?? []) as PeriodRow[];
}

async function periodRow(osClientId: string, start: string): Promise<PeriodRow | null> {
  const { data, error } = await osTable("os_usage_billing_periods").select("*").eq("os_client_id", osClientId).eq("period_start", start).maybeSingle();
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return (data as PeriodRow | null) ?? null;
}

/**
 * Which period: the one asked for (it must begin a period of this schedule
 * and not lie in the future), else the last one that has ended, else — for a
 * test, while the first period is still running — the current one.
 */
export function choosePeriod(s: Pick<SettingsRow, "anchor_date" | "every_days">, today: string, asked?: string | null): Period {
  const every = s.every_days as EveryDays;
  if (asked) {
    if (!isPeriodStart(s.anchor_date, every, asked)) throw new UsageBillingError(`${asked} does not begin a billing period (every ${every} days from ${s.anchor_date}).`, 400);
    if (asked > today) throw new UsageBillingError("That period has not started yet.", 400);
    return periodOf(s.anchor_date, every, asked)!;
  }
  const p = lastCompletedPeriod(s.anchor_date, every, today) ?? periodOf(s.anchor_date, every, today);
  if (!p) throw new UsageBillingError(`The first period starts ${s.anchor_date}.`, 400);
  return p;
}

/** Every lead key billed for this client on any OTHER period — never billed again (model.ts keysAlreadyBilled). */
async function keysBilledElsewhere(osClientId: string, exceptStart: string): Promise<Set<string>> {
  const { data, error } = await osTable("os_usage_billing_periods").select("period_start, status, leads").eq("os_client_id", osClientId).in("status", [...BILLED_STATUSES]);
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return keysAlreadyBilled((data ?? []) as Array<{ period_start: string; status: string; leads: unknown }>, exceptStart);
}

export interface Preview {
  period: Period;
  periodKey: string;
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
  /** TEST PATH ONLY: leads typed in instead of the lead source. */
  fakeLeads?: unknown;
  now?: Date;
  /** Tests: another lead source. */
  source?: LeadSourceFn;
}

/** What the period's invoice would be. Reads only — nothing is written anywhere. */
export async function previewPeriod(osClientId: string, s: SettingsRow, o: PreviewOptions = {}): Promise<Preview> {
  const today = easternDay(o.now ?? new Date());
  const period = choosePeriod(s, today, o.periodStart ?? null);
  const source = (s.lead_source === "introductions" ? "introductions" : s.lead_source === "handoffs" ? "handoffs" : DEFAULT_LEAD_SOURCE) as LeadSource;
  let raw: BillableLead[];
  if (o.fakeLeads !== undefined && o.fakeLeads !== null && o.fakeLeads !== "") {
    const parsed = parseFakeLeads(o.fakeLeads, period);
    if ("error" in parsed) throw new UsageBillingError(parsed.error, 400);
    raw = parsed;
  } else {
    raw = await (o.source ? o.source(osClientId, period.start, period.end) : billableLeads(osClientId, period.start, period.end, source));
  }
  const d = dedupeLeads(raw, await keysBilledElsewhere(osClientId, period.start));
  if (d.billable.length > MAX_LEADS_PER_PERIOD) throw new UsageBillingError(`${d.billable.length} leads in one period is more than the ${MAX_LEADS_PER_PERIOD} allowed — check the lead source before billing.`, 409);
  const price = s.price_cents;
  return {
    period,
    periodKey: periodKey(osClientId, period.start),
    leadSource: o.fakeLeads ? "test" : source,
    priceCents: price,
    leads: d.billable,
    skipped: d.skipped,
    count: d.billable.length,
    amountCents: amountCents(d.billable.length, price),
    description: invoiceDescription(period, d.billable.length, price),
    lines: d.billable.map((l) => ({ description: lineDescription(l), amountCents: price })),
    existing: await periodRow(osClientId, period.start),
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
}

async function updateRow(id: string, from: PeriodStatus, patch: Row): Promise<PeriodRow | null> {
  const { data, error } = await osTable("os_usage_billing_periods").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).eq("status", from).select("*");
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return ((data ?? []) as PeriodRow[])[0] ?? null;
}

/** The period's row, created as a 'preview' if it is not there (never overwriting one that is). */
async function ensurePeriodRow(osClientId: string, s: SettingsRow, period: Period): Promise<void> {
  const { error } = await osTable("os_usage_billing_periods").upsert(
    {
      os_client_id: osClientId, period_start: period.start, period_end: period.end, test_mode: true, status: "preview",
      lead_source: s.lead_source, price_cents: s.price_cents, lead_count: 0, amount_cents: 0, leads: [],
    },
    { onConflict: "os_client_id,period_start", ignoreDuplicates: true },
  );
  if (error) throw dbError("os_usage_billing_periods", error.message);
}

/** The scheduled run without OS_USAGE_BILLING_CHARGE: records what it WOULD bill, on a 'preview' row only. */
export async function recordPreview(osClientId: string, s: SettingsRow, period: Period, o: { now?: Date; source?: LeadSourceFn } = {}): Promise<PeriodRow | null> {
  const p = await previewPeriod(osClientId, s, { periodStart: period.start, now: o.now, source: o.source });
  await ensurePeriodRow(osClientId, s, period);
  const { data, error } = await osTable("os_usage_billing_periods")
    .update({
      leads: p.leads, lead_count: p.count, amount_cents: p.amountCents, price_cents: p.priceCents, lead_source: p.leadSource,
      note: `Preview ${new Date().toISOString().slice(0, 16)}Z — not charged`, updated_at: new Date().toISOString(),
    })
    .eq("os_client_id", osClientId).eq("period_start", period.start).eq("status", "preview")
    .select("*");
  if (error) throw dbError("os_usage_billing_periods", error.message);
  return ((data ?? []) as PeriodRow[])[0] ?? null;
}

/**
 * Bills one period of a TEST client: claims it, builds the invoice (one line
 * per lead), checks it, finalizes it and charges the saved card — all in
 * Stripe TEST mode. A period already claimed is never billed again.
 */
export async function chargePeriod(osClientId: string, o: ChargeOptions): Promise<ChargeResult> {
  const s = await testClient(osClientId);
  if (!s.stripe_customer_id || !s.default_payment_method_id) throw new UsageBillingError("No card is saved for this client yet — send the card-setup link first.", 409);
  const now = o.now ?? new Date();
  const period = choosePeriod(s, easternDay(now), o.periodStart ?? null);

  // Already claimed? Billed (or settled) periods are final; a claim that died is resumed once stale.
  const existing = await periodRow(osClientId, period.start);
  if (existing && existing.status !== "preview") {
    const stale = existing.status === "draft" && (!existing.claimed_at || now.getTime() - Date.parse(existing.claimed_at) > CLAIM_STALE_MS);
    if (!stale) {
      return { outcome: existing.status === "draft" ? "in_progress" : "already", period, row: existing, invoice: null, message: alreadyMessage(existing) };
    }
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
  await ensurePeriodRow(osClientId, s, period);
  const claimed = await osTable("os_usage_billing_periods")
    .update({
      status: p.count ? "draft" : "void",
      leads: p.leads, lead_count: p.count, amount_cents: p.amountCents, price_cents: p.priceCents, lead_source: p.leadSource,
      claimed_by: o.by, claimed_at: now.toISOString(), error: null,
      note: p.count ? null : "No billable leads in this period — nothing charged.",
      updated_at: now.toISOString(),
    })
    .eq("os_client_id", osClientId).eq("period_start", period.start).eq("status", "preview")
    .select("*");
  if (claimed.error) throw dbError("os_usage_billing_periods", claimed.error.message);
  const row = ((claimed.data ?? []) as PeriodRow[])[0];
  if (!row) {
    const now2 = await periodRow(osClientId, period.start);
    return { outcome: now2?.status === "draft" ? "in_progress" : "already", period, row: now2, invoice: null, message: now2 ? alreadyMessage(now2) : "Taken by another run." };
  }
  if (!p.count) return { outcome: "nothing", period, row, invoice: null, message: "No billable leads in this period — nothing charged." };
  return bill(row, s, o.stripe, false);
}

function alreadyMessage(r: PeriodRow): string {
  switch (r.status) {
    case "draft": return "This period is being billed right now — try again in a few minutes.";
    case "charged": return "This period's invoice has been charged; waiting for Stripe's answer.";
    case "paid": return "This period has been billed and paid already.";
    case "failed": return "This period has been billed; the card was refused — the invoice is open and payable by its link.";
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
  const fail = async (message: string, from: PeriodStatus = "draft"): Promise<ChargeResult> => {
    const r = await updateRow(row.id, from, { status: "failed", error: message.slice(0, 1000) });
    return { outcome: "failed", period, row: r ?? row, invoice: null, message };
  };

  try {
    // 1. The invoice: the one on the row, else (a resume) the one Stripe already has for this period, else a new draft.
    let invoiceId = row.stripe_invoice_id;
    if (!invoiceId && resuming) invoiceId = (await stripe.findPeriodInvoice(customerId, key))?.id ?? null;
    if (!invoiceId) {
      invoiceId = (await stripe.createDraftInvoice({
        customerId, paymentMethodId: s.default_payment_method_id, osClientId: row.os_client_id, period, periodKey: key,
        description: invoiceDescription(period, leads.length, row.price_cents), leadCount: leads.length,
      })).invoiceId;
    }
    if (invoiceId !== row.stripe_invoice_id) await updateRow(row.id, "draft", { stripe_invoice_id: invoiceId });

    // 2. One line per lead — only the ones not on it yet.
    let inv = await stripe.getInvoice(invoiceId);
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

    // 4. Finalize, then charge the saved card.
    if (inv.status === "draft") inv = await stripe.finalizeInvoice(invoiceId, `${key}:finalize`);
    const charged = await updateRow(row.id, "draft", {
      status: "charged", charged_at: new Date().toISOString(), stripe_invoice_number: inv.number, hosted_invoice_url: inv.hostedUrl,
    });
    const from: PeriodStatus = charged ? "charged" : "draft";
    if (inv.status === "open") {
      const paid = await stripe.payInvoice(invoiceId, `${key}:pay`);
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
    throw new UsageBillingError(`Stripe did not finish (${message}). Nothing is charged twice: try again after ${Math.round(CLAIM_STALE_MS / 60_000)} minutes and it resumes where it stopped.`, 502);
  }
}

/**
 * Reads a billed period's invoice back from Stripe and records what it says:
 * paid (by the saved card, or by the client through the invoice's link after a
 * refused card), still open, or voided in Stripe. Writes only the period row.
 */
export async function refreshPeriod(osClientId: string, periodStart: string, stripe: UsageStripe): Promise<PeriodRow | null> {
  const row = await periodRow(osClientId, periodStart);
  if (!row || !row.stripe_invoice_id || !["charged", "failed", "paid"].includes(row.status)) return row;
  const inv = await stripe.getInvoice(row.stripe_invoice_id);
  const patch: Row = { stripe_invoice_number: inv.number, hosted_invoice_url: inv.hostedUrl };
  if (inv.status === "paid" && row.status !== "paid") Object.assign(patch, { status: "paid", paid_at: new Date().toISOString(), error: null });
  else if (inv.status === "void" && row.status !== "paid") Object.assign(patch, { status: "void", note: "Voided in Stripe." });
  return (await updateRow(row.id, row.status, patch)) ?? row;
}

/* ------------------------------------------------------ scheduled run --- */

export interface RunResult {
  off?: string;
  clients: number;
  previews: number;
  charged: number;
  skipped: number;
  errors: string[];
}

/**
 * The scheduled run (instrumentation.ts). Does nothing unless
 * OS_USAGE_BILLING_ENABLED=1 on Railway. Then, for each ENABLED client, the
 * periods that have ended (at most two back): with OS_USAGE_BILLING_CHARGE=1
 * and a TEST key it bills TEST clients; otherwise it only records previews.
 * A client that is not test_only is never charged by this version.
 */
export async function runUsageBilling(o: { env?: Record<string, string | undefined>; now?: Date; stripe?: UsageStripe | null; source?: LeadSourceFn } = {}): Promise<RunResult> {
  const env = o.env ?? process.env;
  const out: RunResult = { clients: 0, previews: 0, charged: 0, skipped: 0, errors: [] };
  if (!schedulerAllowed(env)) return { ...out, off: "OS_USAGE_BILLING_ENABLED is not 1 on Railway" };
  let stripe: UsageStripe | null = null;
  if (scheduledChargeAllowed(env)) {
    try {
      stripe = o.stripe ?? usageStripe(usageBillingStripeKey(env));
    } catch (e) {
      out.errors.push(`charging off: ${e instanceof Error ? e.message : e}`);
    }
  }
  const now = o.now ?? new Date();
  const today = easternDay(now);
  const { data, error } = await osTable("os_usage_billing_settings").select(SETTINGS_COLUMNS).eq("enabled", true);
  if (error) throw dbError("os_usage_billing_settings", error.message);
  for (const s of (data ?? []) as SettingsRow[]) {
    out.clients += 1;
    // Invoices charged or refused earlier: paid since (a retry, or the client through the link)?
    if (stripe && s.test_only === true) {
      const open = (await listPeriods(s.os_client_id, 8)).filter((r) => r.status === "charged" || r.status === "failed");
      for (const r of open) {
        try { await refreshPeriod(s.os_client_id, r.period_start, stripe); } catch (e) { out.errors.push(`${s.os_client_id} ${r.period_start} refresh: ${e instanceof Error ? e.message : e}`); }
      }
    }
    if (testBillingRefusal({ ...s, test_only: true })) { out.skipped += 1; continue; }
    for (const period of duePeriods(s.anchor_date, s.every_days as EveryDays, today)) {
      try {
        const existing = await periodRow(s.os_client_id, period.start);
        if (existing && existing.status !== "preview") { out.skipped += 1; continue; }
        const canCharge = stripe && s.test_only === true && s.stripe_customer_id && s.default_payment_method_id;
        if (canCharge) {
          const r = await chargePeriod(s.os_client_id, { stripe: stripe!, by: "scheduled run", periodStart: period.start, now, source: o.source });
          if (r.outcome === "paid" || r.outcome === "failed" || r.outcome === "charged") out.charged += 1;
          else out.skipped += 1;
        } else {
          await recordPreview(s.os_client_id, s, period, { now, source: o.source });
          out.previews += 1;
        }
      } catch (e) {
        out.errors.push(`${s.os_client_id} ${period.start}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return out;
}
