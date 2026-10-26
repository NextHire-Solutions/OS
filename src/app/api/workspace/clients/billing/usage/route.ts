import { NextResponse } from "next/server";

import { billingTabUser } from "@/lib/clients/billing-user";
import { osTable } from "@/lib/clients/os-db";
import {
  chargePeriod, confirmSetup, createSetupLink, listPeriods, loadSettings, previewPeriod, refreshPeriod, saveSettings, UsageBillingError,
} from "@/lib/clients/usage-billing/billing";
import {
  DEFAULT_LEAD_SOURCE, duePeriods, easternDay, LEAD_SOURCE_NAMES, lastCompletedPeriod, parseSettingsInput, periodLabel, periodOf,
  testBillingRefusal, type EveryDays,
} from "@/lib/clients/usage-billing/model";
import { usageBillingKeyState, usageBillingStripeKey, UsageBillingKeyError } from "@/lib/clients/usage-billing/stripe-key";
import { usageStripe, UsageStripeError, type UsageStripe } from "@/lib/clients/usage-billing/stripe";
import { publicOrigin } from "@/lib/mcp/oauth";

/*
 * Pay per lead — the TEST path (26 Oct 2026). Nothing here can charge a real
 * client or use a live key:
 *
 *   - Only the people named in billing-access.ts (the Billing tab's own rule,
 *     billingTabUser); anyone else, signed in or not, gets a bare 404.
 *   - Every Stripe call uses OS_USAGE_BILLING_STRIPE_KEY, which must be a
 *     Stripe TEST key (stripe-key.ts) — anything else is refused before a
 *     request is built. Never the OS's shared key, which defaults to live.
 *   - Every action but saving the settings refuses a client that is not
 *     marked test_only in os_usage_billing_settings (model.ts
 *     testBillingRefusal). Saving creates the row test_only = true; nothing
 *     here can set it false.
 *   - POSTs only from the OS's own page (as the refund route).
 *
 *   GET  ?clientId=…                         settings, periods, the schedule, the key's state, the
 *                                            customer's test-mode invoices
 *   POST { clientId, action: "save", price | priceCents, everyDays, anchorDate, leadSource?, enabled? }
 *   POST { clientId, action: "setup_link" }  a Stripe Checkout page (mode=setup) to save a card (4242…)
 *   POST { clientId, action: "confirm_setup" }  reads it back; its card becomes the default
 *   POST { clientId, action: "preview", periodStart?, fakeLeads? }   the invoice it would make — writes nothing
 *   POST { clientId, action: "charge", periodStart?, fakeLeads? }    claims the period, builds the invoice
 *                                            (one line per lead), finalizes it and charges the test card
 *   POST { clientId, action: "refresh", periodStart }                re-reads a billed period's invoice
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["save", "setup_link", "confirm_setup", "preview", "charge", "refresh"]);
const STRIPE_ACTIONS = new Set(["setup_link", "confirm_setup", "charge", "refresh"]);

/* The staff cookie travels with requests from other brokerstaffer.com sites too: a write comes only from this page. */
function fromOwnPage(request: Request): boolean {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin") === publicOrigin();
}

async function clientExists(clientId: string): Promise<boolean> {
  const { data } = await osTable("os_clients").select("id").eq("id", clientId).maybeSingle();
  return !!data;
}

function fail(e: unknown, what: string): NextResponse {
  if (e instanceof UsageBillingKeyError) return say(e.reason === "missing" ? 503 : 403, e.message);
  if (e instanceof UsageBillingError) return say(e.status, e.message);
  if (e instanceof UsageStripeError) return say(502, e.message);
  console.error(`[usage-billing] ${what} failed:`, e);
  return say(500, e instanceof Error ? e.message : "Something went wrong.");
}

export async function GET(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  if (!UUID.test(clientId) || !(await clientExists(clientId))) return say(404, "No such client.");
  try {
    const keyState = usageBillingKeyState();
    const settings = await loadSettings(clientId);
    const periods = settings ? await listPeriods(clientId) : [];
    const today = easternDay(new Date());
    let schedule = null;
    if (settings) {
      const every = settings.every_days as EveryDays;
      const current = periodOf(settings.anchor_date, every, today);
      const last = lastCompletedPeriod(settings.anchor_date, every, today);
      const choices = [...duePeriods(settings.anchor_date, every, today, 6), ...(current ? [current] : [])].reverse();
      schedule = {
        current: current ? { ...current, label: periodLabel(current) } : null,
        lastCompleted: last ? { ...last, label: periodLabel(last) } : null,
        firstStarts: current ? null : settings.anchor_date,
        choices: choices.map((p) => ({ ...p, label: periodLabel(p), running: p.end > today })),
      };
    }
    let invoices = null, invoicesError: string | null = null;
    if (settings?.stripe_customer_id && keyState === "test" && !testBillingRefusal(settings)) {
      try {
        invoices = await usageStripe(usageBillingStripeKey()).listInvoices(settings.stripe_customer_id, 24);
      } catch (e) {
        invoicesError = e instanceof Error ? e.message : "Stripe could not be read";
      }
    }
    return NextResponse.json({
      settings, periods, schedule, invoices, invoicesError, today,
      keyState,
      refusal: settings ? testBillingRefusal(settings) : null,
      flags: { scheduler: process.env.OS_USAGE_BILLING_ENABLED === "1", charge: process.env.OS_USAGE_BILLING_CHARGE === "1" },
      leadSources: LEAD_SOURCE_NAMES,
      defaultLeadSource: DEFAULT_LEAD_SOURCE,
    }, { headers: NO_STORE });
  } catch (e) {
    return fail(e, "read");
  }
}

export async function POST(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  if (!fromOwnPage(request)) return say(403, "Forbidden");
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : "";
  const action = String(body?.action ?? "");
  if (!UUID.test(clientId) || !ACTIONS.has(action)) return say(400, `clientId and action (${[...ACTIONS].join(", ")}) are required.`);
  if (!(await clientExists(clientId))) return say(404, "No such client.");

  try {
    if (action === "save") {
      const input = parseSettingsInput(body);
      if ("error" in input) return say(400, input.error);
      const settings = await saveSettings(clientId, input, who.email);
      console.log(`[usage-billing] ${who.email} saved pay-per-lead settings (TEST) for ${clientId}: ${input.priceCents}c every ${input.everyDays}d from ${input.anchorDate}, ${input.leadSource}, ${input.enabled ? "on" : "off"}`);
      return NextResponse.json({ ok: true, settings }, { headers: NO_STORE });
    }

    // The client must be a TEST client — before any key or Stripe is touched.
    const settings = await loadSettings(clientId);
    const refusal = testBillingRefusal(settings);
    if (refusal) return say(403, refusal);
    const periodStart = typeof body?.periodStart === "string" && body.periodStart ? body.periodStart : null;

    if (action === "preview") {
      const p = await previewPeriod(clientId, settings!, { periodStart, fakeLeads: body?.fakeLeads });
      return NextResponse.json({ ok: true, preview: { ...p, label: periodLabel(p.period) } }, { headers: NO_STORE });
    }

    // A TEST key, or nothing happens (stripe-key.ts) — checked before the client is built.
    let stripe: UsageStripe;
    if (STRIPE_ACTIONS.has(action)) stripe = usageStripe(usageBillingStripeKey());
    else return say(400, "Unknown action.");

    if (action === "setup_link") {
      const link = await createSetupLink(clientId, stripe, publicOrigin());
      console.log(`[usage-billing] ${who.email} made a TEST card-setup link for ${clientId} (${link.sessionId})`);
      return NextResponse.json({ ok: true, url: link.url }, { headers: NO_STORE });
    }
    if (action === "confirm_setup") {
      const r = await confirmSetup(clientId, stripe);
      return NextResponse.json({ ok: true, ...r, settings: await loadSettings(clientId) }, { headers: NO_STORE });
    }
    if (action === "refresh") {
      if (!periodStart) return say(400, "periodStart is required.");
      const row = await refreshPeriod(clientId, periodStart, stripe);
      return NextResponse.json({ ok: true, row, periods: await listPeriods(clientId) }, { headers: NO_STORE });
    }
    // charge
    const r = await chargePeriod(clientId, { stripe, by: who.email, periodStart, fakeLeads: body?.fakeLeads });
    console.log(`[usage-billing] ${who.email} TEST charge for ${clientId} ${r.period.start}: ${r.outcome}${r.invoice ? ` (${r.invoice.id}, ${r.invoice.total}c, ${r.invoice.status})` : ""}`);
    const status = r.outcome === "already" || r.outcome === "in_progress" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...r, label: periodLabel(r.period), periods: await listPeriods(clientId), error: status === 409 ? r.message : undefined }, { status, headers: NO_STORE });
  } catch (e) {
    return fail(e, action);
  }
}
