import "server-only";

import { stripeGet } from "@/lib/commissions/stripe-payments";
import { osTable } from "@/lib/clients/os-db";
import { forgetSignIns, getAccountBilling, getStripeSnapshot } from "@/lib/clients/billing-account";

import { ONBOARDED_RECENTLY_MS, paymentAlerts, RECENT_PAYMENT_MS, type PaidCheckout } from "./stripe-payment-alerts";

/*
 * New payments → the bell, every 5 minutes, and straight after an onboarding (6 Nov; the rule is stripe-payment-alerts.ts).
 *
 * Read-only on Stripe: one list of the last two days' completed Checkouts, and the account snapshot billing already keeps,
 * read again when a payment is newer than it, or when an onboarding asks (`fresh`). Writes only os_notifications, each
 * keyed so it is said once. It never creates or changes a client, a link, or anything in Stripe.
 */

type RawCheckout = {
  id: string;
  created: number;
  customer: string | { id: string } | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  amount_total: number | null;
  mode: string;
  subscription: string | { id: string } | null;
  payment_status: string;
  custom_fields?: Array<{
    key: string;
    label?: { custom?: string | null } | null;
    text?: { value?: string | null } | null;
    numeric?: { value?: string | null } | null;
    dropdown?: { value?: string | null; options?: Array<{ label: string; value: string }> } | null;
  }>;
};

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

export function toCheckout(s: RawCheckout): PaidCheckout {
  return {
    id: s.id,
    created: s.created,
    customer: idOf(s.customer),
    email: s.customer_details?.email ?? null,
    name: s.customer_details?.name ?? null,
    amount: (s.amount_total ?? 0) / 100,
    mode: s.mode,
    subscription: idOf(s.subscription),
    answers: (s.custom_fields ?? []).map((f) => {
      const picked = f.dropdown?.value ?? null;
      const value = f.text?.value ?? f.numeric?.value ?? (picked ? f.dropdown?.options?.find((o) => o.value === picked)?.label ?? picked : null) ?? "";
      return { label: f.label?.custom ?? f.key, value };
    }),
  };
}

/** Paid Checkouts in the last two days. Setups and free trials (no_payment_required) aren't payments. */
async function recentCheckouts(now: number): Promise<PaidCheckout[]> {
  const out: PaidCheckout[] = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ limit: "100", status: "complete", "created[gte]": String(Math.floor((now - RECENT_PAYMENT_MS) / 1000)) });
    if (after) q.set("starting_after", after);
    const res = await stripeGet(`https://api.stripe.com/v1/checkout/sessions?${q}`);
    const body = (await res.json().catch(() => null)) as { data?: RawCheckout[]; has_more?: boolean; error?: { message?: string } } | null;
    if (!res.ok || !body?.data) throw new Error(`Stripe: ${body?.error?.message ?? res.status}`);
    for (const s of body.data) if (s.payment_status === "paid") out.push(toCheckout(s));
    if (!body.has_more || !body.data.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return out;
}

/*
 * Which of these "counted" and "found" alerts the bell has said already, and the subscriptions they named. Asked by ref, so the answer
 * is complete however many alerts the bell holds (a read of "all of them" stops at the server's 1,000 rows).
 */
async function saidAlready(refs: string[]): Promise<{ said: Set<string>; named: Set<string> }> {
  const said = new Set<string>();
  const named = new Set<string>();
  for (let i = 0; i < refs.length; i += 100) {
    const { data, error } = await osTable("os_notifications").select("ref, body").in("ref", refs.slice(i, i + 100));
    if (error) throw new Error(`os_notifications: ${error.message}`);
    for (const r of (data ?? []) as Array<{ ref: string; body: string | null }>) {
      said.add(r.ref);
      for (const sub of (r.body ?? "").match(/\bsub_[A-Za-z0-9]+/g) ?? []) named.add(sub);
    }
  }
  return { said, named };
}

/*
 * Of these clients, those a "Payment from X, not on their Billing tab" alert in the bell names: a payment Stripe kept no
 * customer for, from an address on X (severity info). That stays true. A "Likely X" hint (a warning) is left out: its
 * payment may since be linked to someone else.
 */
async function paymentAlertClients(clientIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < clientIds.length; i += 100) {
    const { data, error } = await osTable("os_notifications").select("os_client_id").eq("kind", "stripe_payment_unmatched").eq("severity", "info").in("os_client_id", clientIds.slice(i, i + 100));
    if (error) throw new Error(`os_notifications: ${error.message}`);
    for (const r of (data ?? []) as Array<{ os_client_id: string | null }>) if (r.os_client_id) out.add(r.os_client_id);
  }
  return out;
}

/** Where it runs: Railway, unless OS_PAYMENT_WATCH_ENABLED=0. A local server shares the database, so it never writes the bell. */
export function paymentWatchAllowed(): boolean {
  if (process.env.OS_PAYMENT_WATCH_ENABLED === "0") return false;
  return !!process.env.MASTER_INBOX_SUPABASE_URL && !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
}

export interface PaymentWatchResult { ready: boolean; notified: number; checkouts: number; error?: string }

/** Stripe was read this recently: not read again for the same reason. */
const REREAD_AFTER_MS = 30_000;
/*
 * Ids Stripe was read again for. Once each: a customer deleted since its payment never shows in Stripe's list, and
 * reading the whole account every pass for it would make every Billing tab wait on a cold read for two days.
 */
const slotIds = globalThis as unknown as { __osPaymentWatchReread?: Set<string> };

const slot = globalThis as unknown as { __osPaymentWatch?: Promise<PaymentWatchResult> | null };

/**
 * One pass. Never two at once: a pass asked for while one runs gets that one's answer — unless it is `fresh` (an
 * onboarding), which then runs again once that one is done, reading Stripe and the sign-in lists again first (unless
 * Stripe was read in the last 30 seconds).
 */
export function runPaymentWatch(o: { now?: number; fresh?: boolean } = {}): Promise<PaymentWatchResult> {
  const running = slot.__osPaymentWatch;
  if (running) return o.fresh ? running.then(() => runPaymentWatch(o), () => runPaymentWatch(o)) : running;
  const run = (async (): Promise<PaymentWatchResult> => {
    const now = o.now ?? Date.now();
    const probe = await osTable("os_notifications").select("id", { head: true, count: "exact" }).limit(1);
    if (probe.error) return { ready: false, notified: 0, checkouts: 0, error: "Needs migrations/0030_billing_profile.sql run first." };
    if (o.fresh) forgetSignIns();
    const checkouts = await recentCheckouts(now);
    const snap = await getStripeSnapshot();
    /*
     * A payment for a customer or subscription the snapshot hasn't seen: Stripe is read again first. Not by comparing
     * times: a Checkout is dated when its page was opened, minutes before it is paid.
     */
    const known = new Set([...snap.customers.map((c) => c.id), ...snap.subscriptions.map((s) => s.id)]);
    const reread = (slotIds.__osPaymentWatchReread ??= new Set<string>());
    if (reread.size > 1000) reread.clear();
    const unseen = checkouts.flatMap((c) => [c.customer, c.subscription]).filter((id): id is string => !!id && !known.has(id) && !reread.has(id));
    if ((unseen.length || o.fresh) && Date.now() - (snap.readAt ?? 0) > REREAD_AFTER_MS) {
      for (const id of unseen) reread.add(id);
      getStripeSnapshot.invalidate();
    }
    const a = await getAccountBilling();
    // Without the links or every address, what is found by email can't be known: nothing is said from half a picture.
    if (!a.linksReady || !a.suggestionsReady) {
      console.warn("[payment-watch] skipped: Stripe links or sign-in lists unreadable");
      return { ready: false, notified: 0, checkouts: checkouts.length, error: "Stripe links or sign-in lists unreadable" };
    }
    /*
     * What the bell may already have said that this pass needs to know: each name match's "counted" alert, each suggestion's
     * "found" alert, and, for a new subscription, its customer's (a "found" alert for a customer since confirmed named it).
     */
    const subIsNew = (id: string) => { const raw = a.snapshot.subscriptions.find((x) => x.id === id); return !!raw && now - raw.created * 1000 <= RECENT_PAYMENT_MS; };
    const refs = new Set<string>(a.suggestions.map((x) => `stripe-found:${x.clientId}:${x.customerId}`));
    for (const [clientId, b] of a.byClient) {
      for (const cu of b.customers) if (cu.source === "name match") refs.add(`stripe-counted:${clientId}:${cu.id}`);
      for (const x of b.subscriptions) if (subIsNew(x.id)) for (const kind of ["found", "counted"]) refs.add(`stripe-${kind}:${clientId}:${x.customer}`);
    }
    const { said, named } = await saidAlready([...refs]);
    // Clients onboarded this week that a payment alert in the bell already names (stripe_no_customer then says nothing).
    const recent = a.refs.filter((c) => c.createdAt != null && now - c.createdAt <= ONBOARDED_RECENTLY_MS).map((c) => c.id);
    const paymentNamed = await paymentAlertClients(recent);
    const alerts = paymentAlerts({ checkouts, clients: a.refs, byClient: a.byClient, snapshot: a.snapshot, suggestions: a.suggestions, excluded: a.excluded, paymentNamed, now, said, named }).filter((n) => !said.has(n.ref));
    let notified = 0;
    for (const n of alerts) {
      // ref is UNIQUE: something already said is simply not inserted again.
      const { data, error } = await osTable("os_notifications")
        .upsert({ kind: n.kind, severity: n.severity, title: n.title, body: n.body, os_client_id: n.clientId, ref: n.ref }, { onConflict: "ref", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`os_notifications: ${error.message}`);
      notified += (data ?? []).length;
    }
    return { ready: true, notified, checkouts: checkouts.length };
  })();
  slot.__osPaymentWatch = run;
  run.then(() => { slot.__osPaymentWatch = null; }, () => { slot.__osPaymentWatch = null; });
  return run;
}
