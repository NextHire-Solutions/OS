import {
 NextResponse } from "next/server";

import { clientsChanged } from "@/lib/clients/after-change";
import { getAccountBilling } from "@/lib/clients/billing-account";
import { billingTabUser } from "@/lib/clients/billing-user";
import { osTable } from "@/lib/clients/os-db";
import {
  cardOptions, chargePeriod, confirmSetup, connectCard, createSetupLink, listPeriods, loadSettings, previewPeriod, refreshPeriod, retryPeriod, reviewPeriods, saveSettings, setAutoCharge,
  unwaiveLead, UsageBillingError, waiveLead, type Approved,
} from "@/lib/clients/usage-billing/billing";
import { addToRestart, capView, removeFromRestart, restartNow, setSpendCap } from "@/lib/clients/usage-billing/caps";
import { perLeadByHealthId } from "@/lib/tools/client-health/per-lead-load";
import { usageBillingLiveKey } from "@/lib/clients/usage-billing/live-key";
import {
  DEFAULT_LEAD_SOURCE, duePeriods, easternDay, LEAD_SOURCE_NAMES, lastCompletedPeriod, modeOf, parseSettingsInput, periodLabel, periodOf,
  settingsRefusal, testBillingRefusal, type EveryDays, type SettingsRow,
  autoChargeProblem, liveAutoChargeAllowed, schedulerAllowed,
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
 *   - A live client is charged only for a period that has ended: here, with
 *     `approved` — the period, leads and amount the person saw; or by the
 *     scheduled run, once someone turned automatic charging on ("set_auto";
 *     billing.ts chargeLiveByRun). The test tools (card-setup page, fake leads)
 *     are refused for a live client.
 *   - POSTs only from the OS's own page (as the refund route).
 *
 *   GET  ?clientId=…                                   settings, mode, periods, the schedule, the invoices
 *   POST { clientId, action: "save", price | priceCents, everyDays, anchorDate, leadSource?, enabled?, expect? }   a live client: `expect` required
 *   POST { clientId, action: "set_auto", on }          LIVE: automatic charging on or off, nothing else; charges nothing itself
 *   POST { clientId, action: "setup_link" }            TEST: a Checkout page (mode=setup) to save a card (4242…)
 *   POST { clientId, action: "confirm_setup" }         TEST: reads it back; its card becomes the default
 *   POST { clientId, action: "find_cards", mode, customerId? }   the client's customers and their cards on file
 *   POST { clientId, action: "connect_card", mode, customerId, paymentMethodId, goLive? }
 *   POST { clientId, action: "preview", periodStart?, fakeLeads? }   the invoice it would make — writes nothing
 *   POST { clientId, action: "period_leads" }          the running period's leads and the last ended one's not charged yet — writes nothing
 *   POST { clientId, action: "waive", periodStart, leadKey, reason }   "Don't bill": keeps one lead off the bill (0050)
 *   POST { clientId, action: "unwaive", periodStart, leadKey }         "Bill it": takes that back
 *   POST { clientId, action: "charge", periodStart?, fakeLeads?, approved? }   claims the period, builds and charges the invoice
 *   POST { clientId, action: "retry", periodStart }    a refused charge, to the card connected now
 *   POST { clientId, action: "refresh", periodStart }  re-reads a billed period's invoice
 *   POST { clientId, action: "set_spend_cap", spendCap }  the spend limit in dollars, or blank for none; nothing else
 *   POST { clientId, action: "cap_add_restart", platform, id }  a campaign a person paused, added to the restart
 *   POST { clientId, action: "cap_remove_restart", platform, id }  a campaign that should stay paused past the window
 *   POST { clientId, action: "cap_restart" }           restart now, when back under the cap
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const say = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["period_leads", "waive", "unwaive", "save", "set_auto", "setup_link", "confirm_setup", "find_cards", "connect_card", "preview", "charge", "retry", "refresh", "set_spend_cap", "cap_add_restart", "cap_remove_restart", "cap_restart"]);

/* The staff cookie travels with requests from other brokerstaffer.com sites too: a write comes only from this page. */
function fromOwnPage(request: Request): boolean {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("origin") === publicOrigin();
}

async function clientRecord(clientId: string): Promise<{ id: string; stripe_customer_id: string | null; status: string | null } | null> {
  const { data } = await osTable("os_clients").select("id, stripe_customer_id, status").eq("id", clientId).maybeSingle();
  return (data as { id: string; stripe_customer_id: string | null; status: string | null } | null) ?? null;
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
 * The Billing tab counts a client's payments by its Stripe customers (billing-model.ts). A live pay-per-lead customer
 * that it does not count for the client yet — a name that doesn't match, no link — is linked, as its own "Link" does,
 * so the payments show on the client's Billing tab, can be refunded there, and are the client's revenue.
 */
async function countForClient(clientId: string, customerId: string, by: string): Promise<"already" | "linked" | "failed"> {
  try {
    const billing = await getAccountBilling().catch(() => null);
    if (billing?.byClient.get(clientId)?.customers.some((c) => c.id === customerId)) return "already";
    await osTable("os_client_stripe_links").delete().eq("os_client_id", clientId).eq("stripe_customer_id", customerId).eq("excluded", true);
    const { error } = await osTable("os_client_stripe_links").insert({ os_client_id: clientId, stripe_customer_id: customerId, stripe_subscription_id: null, created_by: by });
    if (error && !/duplicate|unique/i.test(error.message)) {
      console.error("[usage-billing] linking the Stripe customer for the Billing tab failed:", error.message);
      return "failed";
    }
    clientsChanged();
    return "linked";
  } catch (e) {
    console.error("[usage-billing] linking the Stripe customer for the Billing tab failed:", e instanceof Error ? e.message : e);
    return "failed";
  }
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
  const clientRow = UUID.test(clientId) ? await clientRecord(clientId) : null;
  if (!clientRow) return say(404, "No such client.");
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
    // The caps panel is its own read: it failing never hides the invoices.
    let cap = null, capError: string | null = null;
    if (settings) {
      try {
        cap = await capView(clientId, settings);
      } catch (e) {
        capError = e instanceof Error ? e.message : "The cap could not be read";
      }
    }
    return NextResponse.json({
      settings, mode, periods, schedule, invoices, invoicesError, today, cap, capError,
      keyState, liveKeyState: liveKey,
      refusal: settings ? settingsRefusal(settings) : null,
      flags: { scheduler: process.env.OS_USAGE_BILLING_ENABLED === "1", charge: process.env.OS_USAGE_BILLING_CHARGE === "1", liveAuto: schedulerAllowed(process.env) && liveAutoChargeAllowed(process.env) },
      autoProblem: settings && mode === "live"
        ? autoChargeProblem({ clientStatus: clientRow.status, leadSource: settings.lead_source, hasCard: !!settings.stripe_customer_id && !!settings.default_payment_method_id, liveKey: liveKey })
        : null,
      leadSources: LEAD_SOURCE_NAMES,
      defaultLeadSource: DEFAULT_LEAD_SOURCE,
    }, { headers: NO_STORE });
  } catch (e) {
    return fail(e, "read");
  }
}

/*
 * Pay per lead changed (its schedule, price, mode, spend limit, a lead waived or billed): Client Health and the master
 * record measure the client by it (client-health/per-lead.ts), so their cached numbers start over at once instead of
 * up to six minutes later. The reads (a preview, the leads, the cards found) change nothing and clear nothing.
 */
const CHANGES_LEADS = new Set(["save", "set_auto", "confirm_setup", "connect_card", "charge", "retry", "refresh", "waive", "unwaive", "set_spend_cap"]);

export async function POST(request: Request) {
  const who = await billingTabUser(request);
  if (who instanceof NextResponse) return who;
  const action = await request.clone().json().then((b: { action?: unknown } | null) => String(b?.action ?? "")).catch(() => "");
  const res = await handlePost(request, who);
  if (res.ok && CHANGES_LEADS.has(action)) {
    perLeadByHealthId.invalidate();
    clientsChanged();
  }
  return res;
}

async function handlePost(request: Request, who: Exclude<Awaited<ReturnType<typeof billingTabUser>>, NextResponse>) {
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
      // A live client: only over the price and schedule the person saw (as going live). One Save carries both, so a page
      // left open from before someone corrected them would otherwise put the old ones back, and a real charge follows them.
      const current = await loadSettings(clientId);
      if (current && modeOf(current) === "live") {
        const seen = body?.expect as { priceCents?: unknown; everyDays?: unknown; anchorDate?: unknown } | undefined;
        if (!seen || seen.priceCents !== current.price_cents || seen.everyDays !== current.every_days || seen.anchorDate !== current.anchor_date) {
          return say(409, "This client's price or schedule changed since you looked — reload the page and check them. Nothing was changed.");
        }
      }
      const settings = await saveSettings(clientId, input, who.email);
      console.log(`[usage-billing] ${who.email} saved pay-per-lead settings (${modeOf(settings).toUpperCase()}) for ${clientId}: ${input.priceCents}c every ${input.everyDays}d from ${input.anchorDate}, ${input.leadSource}, ${settings.enabled ? "on" : "off"}`);
      return NextResponse.json({ ok: true, settings }, { headers: NO_STORE });
    }

    const settings = await loadSettings(clientId);
    const refusal = settingsRefusal(settings);
    if (refusal) return say(403, refusal);
    const s = settings as SettingsRow;
    const mode = modeOf(s);
    const periodStart = typeof body?.periodStart === "string" && body.periodStart ? body.periodStart : null;

    if (action === "set_auto") {
      if (typeof body?.on !== "boolean") return say(400, "on must be true or false.");
      const saved = await setAutoCharge(clientId, body.on, who.email);
      return NextResponse.json({ ok: true, settings: saved }, { headers: NO_STORE });
    }

    if (action === "set_spend_cap" || action === "cap_add_restart" || action === "cap_remove_restart" || action === "cap_restart") {
      let restarted: number | null = null;
      if (action === "set_spend_cap") await setSpendCap(clientId, s, body?.spendCap, who.email);
      else if (action === "cap_add_restart") await addToRestart(clientId, s, { platform: body?.platform, id: body?.id });
      else if (action === "cap_remove_restart") await removeFromRestart(clientId, s, { platform: body?.platform, id: body?.id });
      else restarted = (await restartNow(clientId, s, who.email)).restarted;
      console.log(`[lead-caps] ${who.email} ${action} for ${clientId}`);
      // It happened: a failure reading the panel back mustn't say otherwise.
      const cap = await capView(clientId, s).catch(() => null);
      return NextResponse.json({ ok: true, restarted, cap }, { headers: NO_STORE });
    }

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

    /*
     * "Don't bill" (6 Nov, migrations/0050): the leads of the running period and of the last ended one not charged yet,
     * and keeping one off the bill or putting it back. Only here, behind the Billing tab's named people: the client
     * portal has no way to reach it.
     */
    if (action === "period_leads") {
      return NextResponse.json({ ok: true, periods: await reviewPeriods(clientId, s) }, { headers: NO_STORE });
    }
    if (action === "waive" || action === "unwaive") {
      if (!periodStart) return say(400, "periodStart is required.");
      const period = action === "waive"
        ? await waiveLead(clientId, s, { periodStart, leadKey: body?.leadKey, reason: body?.reason, by: who.email })
        : await unwaiveLead(clientId, s, { periodStart, leadKey: body?.leadKey, by: who.email });
      // Every list again: the same agent can be in both, and a waiver covers both. It happened: a failure reading back mustn't say otherwise.
      const periods = await reviewPeriods(clientId, s).catch(() => null);
      const cap = await capView(clientId, s).catch(() => null);
      return NextResponse.json({ ok: true, period, periods, cap }, { headers: NO_STORE });
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
      // connect_card — going live needs it said in so many words, for the price and schedule the person saw.
      if (want === "live" && mode === "test" && body?.goLive !== true) return say(400, "Connecting a live card makes this client live — confirm it (goLive).");
      if (want === "live" && mode === "live" && body?.goLive === true) return say(409, "This client is already live — reload the page.");
      if (want === "live" && mode === "test") {
        const seen = body?.expect as { priceCents?: unknown; everyDays?: unknown; anchorDate?: unknown } | undefined;
        if (!seen || seen.priceCents !== s.price_cents || seen.everyDays !== s.every_days || seen.anchorDate !== s.anchor_date) {
          return say(409, "This client's price or schedule changed since you looked — reload the page and check them before going live. Nothing was changed.");
        }
      }
      const customerId = typeof body?.customerId === "string" ? body.customerId : "";
      const paymentMethodId = typeof body?.paymentMethodId === "string" ? body.paymentMethodId : "";
      let claimedBy: string[] = [];
      if (want === "live") {
        const claims = await otherClaims(clientId);
        if (!claims) return say(503, "Couldn't check which client this Stripe customer belongs to (Stripe didn't answer) — nothing was changed. Try again in a minute.");
        claimedBy = claims.get(customerId) ?? [];
      }
      const saved = await connectCard(clientId, { customerId, paymentMethodId, claimedBy }, stripeFor(want), who.email);
      // Live: the customer counts for this client on the Billing tab too — its pay-per-lead payments, refunds and revenue.
      const linked = want === "live" ? await countForClient(clientId, customerId, who.email) : null;
      return NextResponse.json({ ok: true, settings: saved, mode: modeOf(saved), linked }, { headers: NO_STORE });
    }

    const stripe = stripeFor(mode);
    if (action === "refresh") {
      if (!periodStart) return say(400, "periodStart is required.");
      const row = await refreshPeriod(clientId, periodStart, stripe);
      return NextResponse.json({ ok: true, row, periods: await listPeriods(clientId, 52, mode === "test") }, { headers: NO_STORE });
    }
    if (action === "retry") {
      if (!periodStart) return say(400, "periodStart is required.");
      // What the person saw: the amount, the leads (count and fingerprint), the mode and the card — checked against the period.
      const seen = body?.approved as Record<string, unknown> | undefined;
      const a = approvedOf({ ...seen, periodStart, count: Number.isInteger(seen?.count) ? seen!.count : 0 });
      const r = await retryPeriod(clientId, periodStart, stripe, who.email, a && { ...a, ...(Number.isInteger(seen?.count) ? {} : { count: undefined }) });
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
