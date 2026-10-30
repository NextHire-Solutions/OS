import { NextResponse } from "next/server";

import { getAccountBilling } from "@/lib/clients/billing-account";
import { billingTabUser } from "@/lib/clients/billing-user";
import { osTable } from "@/lib/clients/os-db";
import {
  cardOptions, chargePeriod, confirmSetup, connectCard, createSetupLink, listPeriods, loadSettings, previewPeriod, refreshPeriod, retryPeriod, saveSettings,
  UsageBillingError, type Approved,
} from "@/lib/clients/usage-billing/billing";
import { usageBillingLiveKey } from "@/lib/clients/usage-billing/live-key";
import {
  DEFAULT_LEAD_SOURCE, duePeriods, easternDay, LEAD_SOURCE_NAMES, lastCompletedPeriod, modeOf, parseSettingsInput, periodLabel, periodOf,
  settingsRefusal, testBillingRefusal, type EveryDays, type SettingsRow,
} from "@/lib/clients/usage-billing/model";
import { usageBillingKeyState, usageBillingStripeKey, UsageBillingKeyError, type UsageMode } from "@/lib/clients/usage-billing/stripe-key";
import { usageStripe, UsageStripeError, type UsageStripe } from "@/lib/clients/usage-billing/stripe";
import { publicOrigin } from "@/lib/mcp/oauth";

/*
 * Pay per lead on a client's Billing tab (26 Oct 2026; live clients 31 Oct).
 *
 *   - Only the people named in billing-access.ts (the Billing tab's own rule,
 *     billingTabUser); anyone else, signed in or not, gets a bare 404.
 *   - A client is billed in its own mode (model.ts modeOf). A TEST client with
 *     OS_USAGE_BILLING_STRIPE_KEY, which must be a Stripe TEST key; a LIVE
 *     client with the OS's own key, which must be a LIVE key (live-key.ts) —
 *     each refused before a request is built (stripe-key.ts).
 *   - A client becomes live only by "connect_card" with mode "live" and
 *     goLive: true — a person picking the client's card on file in live Stripe.
 *   - A live client is charged only with `approved` — the period, leads and
 *     amount the person saw — and only for a period that has ended. The test
 *     tools (card-setup page, fake leads) are refused for a live client.
 *   - POSTs only from the OS's own page (as the refund route).
 *
 *   GET  ?clientId=…                                   settings, mode, periods, the schedule, the invoices
 *   POST { clientId, action: "save", price | priceCents, everyDays, anchorDate, leadSource?, enabled? }
 *   POST { clientId, action: "setup_link" }            TEST: a Checkout page (mode=setup) to save a card (4242…)
 *   POST { clientId, action: "confirm_setup" }         TEST: reads it back; its card becomes the default
 *   POST { clientId, action: "find_cards", mode, customerId? }   the client's customers and their cards on file
 *   POST { clientId, action: "connect_card", mode, customerId, paymentMethodId, goLive? }
 *   POST { clientId, action: "preview", periodStart?, fakeLeads? }   the invoice it would make — writes nothing
 *   POST { clientId, action: "charge", periodStart?, fakeLeads?, approved? }   claims the period, builds and charges the invoice
 *   POST { clientId, action: "retry", periodStart }    a refused charge, to the card connected now
 *   POST { clientId, action: "refresh", periodStart }  re-reads a billed period's invoice
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["save", "setup_link", "confirm_setup", "find_cards", "connect_card", "preview", "charge", "retry", "refresh"]);

/* The staff cookie travels with requests from other brokerstaffer.com sites too: a write comes only from this page. */
function fromOwnPage(request: Request): boolean {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin") === publicOrigin();
}

async function clientRecord(clientId: string): Promise<{ id: string; stripe_customer_id: string | null } | null> {
  const { data } = await osTable("os_clients").select("id, stripe_customer_id").eq("id", clientId).maybeSingle();
  return (data as { id: string; stripe_customer_id: string | null } | null) ?? null;
}

/** The Stripe a mode bills with — its key checked before the client is built. */
function stripeFor(mode: UsageMode): UsageStripe {
  return mode === "live" ? usageStripe(usageBillingLiveKey(), fetch, "live") : usageStripe(usageBillingStripeKey(), fetch, "test");
}

/** For the screen: whether the live key is usable (never the key). */
function liveKeyState(): "live" | "missing" | "refused" {
  try {
    usageBillingLiveKey();
    return "live";
  } catch (e) {
    return e instanceof UsageBillingKeyError && e.reason === "not_live" ? "refused" : "missing";
  }
}

function fail(e: unknown, what: string): NextResponse {
  if (e instanceof UsageBillingKeyError) return say(e.reason === "missing" ? 503 : 403, e.message);
  if (e instanceof UsageBillingError) return say(e.status, e.message);
  if (e instanceof UsageStripeError) return say(502, e.message);
  console.error(`[usage-billing] ${what} failed:`, e);
  return say(500, e instanceof Error ? e.message : "Something went wrong.");
}

/** What the person approved, as sent by the screen — or null. */
function approvedOf(v: unknown): Approved | null {
  const a = v as { periodStart?: unknown; count?: unknown; amountCents?: unknown; mode?: unknown; paymentMethodId?: unknown; leadsHash?: unknown } | null;
  if (!a || typeof a.periodStart !== "string" || !Number.isInteger(a.count) || !Number.isInteger(a.amountCents)) return null;
  return {
    periodStart: a.periodStart, count: a.count as number, amountCents: a.amountCents as number,
    ...(a.mode === "test" || a.mode === "live" ? { mode: a.mode } : {}),
    ...(typeof a.paymentMethodId === "string" || a.paymentMethodId === null ? { paymentMethodId: a.paymentMethodId as string | null } : {}),
    ...(typeof a.leadsHash === "string" ? { leadsHash: a.leadsHash } : {}),
  };
}

/**
 * Which OTHER clients the Billing tab counts each Stripe customer for — by the record, a link, a subscription or the
 * name (billing-model.ts): customer id → their names. Null when live Stripe could not be read, so nothing is assumed.
 */
async function otherClaims(clientId: string): Promise<Map<string, string[]> | null> {
  try {
    const billing = await getAccountBilling();
    const others = [...billing.byClient.keys()].filter((id) => id !== clientId);
    const names = new Map<string, string>();
    for (let i = 0; i < others.length; i += 100) {
      const { data } = await osTable("os_clients").select("id, name").in("id", others.slice(i, i + 100));
      for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(r.id, r.name ?? "another client");
    }
    const out = new Map<string, string[]>();
    for (const [id, b] of billing.byClient) {
      if (id === clientId) continue;
      for (const c of b.customers) out.set(c.id, [...(out.get(c.id) ?? []), names.get(id) ?? "another client"]);
    }
    return out;
  } catch (e) {
    console.error("[usage-billing] who owns which Stripe customer could not be read:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function GET(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  const clientId = new URL(request.url).searchParams.get("clientId") ?? "";
  if (!UUID.test(clientId) || !(await clientRecord(clientId))) return say(404, "No such client.");
  try {
    const keyState = usageBillingKeyState();
    const settings = await loadSettings(clientId);
    const mode = settings ? modeOf(settings) : "test";
    const periods = settings ? await listPeriods(clientId, 52, mode === "test") : [];
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
    // The client's pay-per-lead invoices in its own mode's Stripe (a live customer's subscription invoices are the Billing tab's).
    let invoices = null, invoicesError: string | null = null;
    // The live key's state for every client: a test client's "Go live" needs it too.
    const liveKey = settings ? liveKeyState() : null;
    if (settings?.stripe_customer_id && !settingsRefusal(settings) && (mode === "live" ? liveKey === "live" : keyState === "test")) {
      try {
        const all = await stripeFor(mode).listInvoices(settings.stripe_customer_id, 24);
        invoices = mode === "live" ? all.filter((i) => i.periodKey) : all;
      } catch (e) {
        invoicesError = e instanceof Error ? e.message : "Stripe could not be read";
      }
    }
    return NextResponse.json({
      settings, mode, periods, schedule, invoices, invoicesError, today,
      keyState, liveKeyState: liveKey,
      refusal: settings ? settingsRefusal(settings) : null,
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
  const record = await clientRecord(clientId);
  if (!record) return say(404, "No such client.");

  try {
    if (action === "save") {
      const input = parseSettingsInput(body);
      if ("error" in input) return say(400, input.error);
      const settings = await saveSettings(clientId, input, who.email);
      console.log(`[usage-billing] ${who.email} saved pay-per-lead settings (${modeOf(settings).toUpperCase()}) for ${clientId}: ${input.priceCents}c every ${input.everyDays}d from ${input.anchorDate}, ${input.leadSource}, ${input.enabled ? "on" : "off"}`);
      return NextResponse.json({ ok: true, settings }, { headers: NO_STORE });
    }

    const settings = await loadSettings(clientId);
    const refusal = settingsRefusal(settings);
    if (refusal) return say(403, refusal);
    const s = settings as SettingsRow;
    const mode = modeOf(s);
    const periodStart = typeof body?.periodStart === "string" && body.periodStart ? body.periodStart : null;

    // The test tools: a test client only — before any key or Stripe is touched.
    if (action === "setup_link" || action === "confirm_setup") {
      const testRefusal = testBillingRefusal(s);
      if (testRefusal) return say(403, testRefusal);
      const stripe = stripeFor("test");
      if (action === "setup_link") {
        const link = await createSetupLink(clientId, stripe, publicOrigin());
        console.log(`[usage-billing] ${who.email} made a TEST card-setup link for ${clientId} (${link.sessionId})`);
        return NextResponse.json({ ok: true, url: link.url }, { headers: NO_STORE });
      }
      const r = await confirmSetup(clientId, stripe);
      return NextResponse.json({ ok: true, ...r, settings: await loadSettings(clientId) }, { headers: NO_STORE });
    }

    if (action === "preview") {
      const p = await previewPeriod(clientId, s, { periodStart, fakeLeads: body?.fakeLeads });
      return NextResponse.json({ ok: true, preview: { ...p, label: periodLabel(p.period) } }, { headers: NO_STORE });
    }

    if (action === "find_cards" || action === "connect_card") {
      const want: UsageMode = body?.mode === "live" ? "live" : "test";
      if (mode === "live" && want === "test") return say(409, "This client is live — its card is in live Stripe.");
      const pasted = typeof body?.customerId === "string" ? body.customerId.trim() : "";
      if (action === "find_cards") {
        const stripe = stripeFor(want);
        let candidates: Array<string | null> = [];
        if (want === "test") {
          candidates = [mode === "test" ? s.stripe_customer_id : null, ...(await stripe.testCustomersOf(clientId))];
        } else {
          // The client's record, its live card (if any), and every Stripe customer the Billing tab counts for it.
          const counted = await getAccountBilling().then((a) => a.byClient.get(clientId)?.customers.map((c) => c.id) ?? []).catch(() => []);
          candidates = [record.stripe_customer_id, mode === "live" ? s.stripe_customer_id : null, ...counted];
        }
        const customers = await cardOptions(stripe, pasted ? [pasted, ...candidates] : candidates);
        // Live: say which customers the Billing tab counts for another client — those can't be connected here.
        const claims = want === "live" ? await otherClaims(clientId) : new Map<string, string[]>();
        return NextResponse.json({
          ok: true, mode: want, claimsChecked: claims !== null,
          customers: customers.map((c) => ({ ...c, claimedBy: claims?.get(c.id) ?? [] })),
          notFound: pasted && !customers.some((c) => c.id === pasted) ? pasted : null,
        }, { headers: NO_STORE });
      }
      // connect_card — going live needs it said in so many words.
      if (want === "live" && mode === "test" && body?.goLive !== true) return say(400, "Connecting a live card makes this client live — confirm it (goLive).");
      const customerId = typeof body?.customerId === "string" ? body.customerId : "";
      const paymentMethodId = typeof body?.paymentMethodId === "string" ? body.paymentMethodId : "";
      let claimedBy: string[] = [];
      if (want === "live") {
        const claims = await otherClaims(clientId);
        if (!claims) return say(503, "Couldn't check which client this Stripe customer belongs to (Stripe didn't answer) — nothing was changed. Try again in a minute.");
        claimedBy = claims.get(customerId) ?? [];
      }
      const saved = await connectCard(clientId, { customerId, paymentMethodId, claimedBy }, stripeFor(want), who.email);
      return NextResponse.json({ ok: true, settings: saved, mode: modeOf(saved) }, { headers: NO_STORE });
    }

    const stripe = stripeFor(mode);
    if (action === "refresh") {
      if (!periodStart) return say(400, "periodStart is required.");
      const row = await refreshPeriod(clientId, periodStart, stripe);
      return NextResponse.json({ ok: true, row, periods: await listPeriods(clientId, 52, mode === "test") }, { headers: NO_STORE });
    }
    if (action === "retry") {
      if (!periodStart) return say(400, "periodStart is required.");
      const r = await retryPeriod(clientId, periodStart, stripe, who.email, approvedOf({ ...(body?.approved as Record<string, unknown> | undefined), periodStart, count: 0 }));
      console.log(`[usage-billing] ${who.email} ${mode.toUpperCase()} retry for ${clientId} ${periodStart}: ${r.outcome}${r.invoice ? ` (${r.invoice.id}, ${r.invoice.total}c, ${r.invoice.status})` : ""}`);
      return NextResponse.json({ ok: true, ...r, label: periodLabel(r.period), periods: await listPeriods(clientId, 52, mode === "test") }, { headers: NO_STORE });
    }
    // charge
    const r = await chargePeriod(clientId, { stripe, by: who.email, periodStart, fakeLeads: body?.fakeLeads, approved: approvedOf(body?.approved) });
    console.log(`[usage-billing] ${who.email} ${mode.toUpperCase()} charge for ${clientId} ${r.period.start}: ${r.outcome}${r.invoice ? ` (${r.invoice.id}, ${r.invoice.total}c, ${r.invoice.status})` : ""}`);
    const status = r.outcome === "already" || r.outcome === "in_progress" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...r, label: periodLabel(r.period), periods: await listPeriods(clientId, 52, mode === "test"), error: status === 409 ? r.message : undefined }, { status, headers: NO_STORE });
  } catch (e) {
    return fail(e, action);
  }
}
