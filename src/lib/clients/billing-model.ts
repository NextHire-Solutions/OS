/*
 * BILLING ACROSS A CLIENT'S SUBSCRIPTIONS — pure, tested (client feedback, 6 Oct).
 *
 * A client is not one Stripe subscription. 54 Realty has paid through four
 * Stripe customers as cards were replaced ("54 Realty LLC (1st Card)" …) and
 * has two live subscriptions; one customer ("Raintown Realty + JPAR") pays
 * for two clients. The OS used to read one subscription per client and count
 * money per CUSTOMER, so 54 Realty's totals missed a subscription and Raintown
 * showed JPAR's money as its own.
 *
 * WHO OWNS WHAT
 *   Subscriptions: an explicit link (os_client_stripe_links), else the one on
 *   the client's record, else a subscription the OS created for it
 *   (metadata.os_client_id).
 *   Customers: claimed by an explicit link, by the record, by owning one of
 *   its subscriptions, or by an automatic NAME match ("MattC Group Old") that
 *   nobody excluded. A customer claimed by one client is wholly that client's.
 *   A customer claimed by several (a shared card) keeps each subscription with
 *   its owner; anything not tied to an owned subscription — old cancelled
 *   subscriptions, one-off payments, the $1 sign-up charge — goes to the
 *   client that was on that customer FIRST.
 *
 * WHAT IS COMPUTED
 *   MRR          live subscriptions (active / past due, collection not
 *                paused), Stripe's monthly way ($750 / 14 days = $1,630.58).
 *   Total spend  successful charges attributed to the client, less refunds.
 *   Current      the newest subscription that is not cancelled.
 *   Sign-up date the first $1 charge (the card check at sign-up). It is the
 *                FIRST across every customer the client has paid through, so
 *                replacing a card does not move it. No $1 charge: the date
 *                entered on the record, else the first charge.
 */

import { AVG_MONTH_DAYS, cents, monthlyAmount } from "./profile-rules.ts";

export interface StripeCustomer { id: string; name: string | null; email: string | null; created: number }
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  created: number;
  canceledAt: number | null;
  /** Stripe's pause_collection, or null when collecting. */
  pause: { behavior: string; resumesAt: number | null } | null;
  /** The next charge (the current period's end). */
  periodEnd: number | null;
  items: { amount: number; interval: string; intervalCount: number; quantity: number }[];
  percentOff: number;
  /** metadata.os_client_id — set on subscriptions the OS created. */
  osClientId: string | null;
}
export interface StripeCharge {
  id: string;
  customer: string | null;
  status: string;
  /** Dollars. */
  amount: number;
  refunded: number;
  created: number;
  /** The subscription the charge paid for, through its invoice; null for one-offs. */
  subscription: string | null;
  failureMessage: string | null;
}
export interface StripeInvoice {
  id: string;
  customer: string;
  subscription: string | null;
  status: string;
  attemptCount: number;
  nextAttempt: number | null;
  amountDue: number;
  amountRemaining: number;
  created: number;
  number: string | null;
  url: string | null;
}
export interface AccountSnapshot {
  customers: StripeCustomer[];
  subscriptions: StripeSubscription[];
  charges: StripeCharge[];
  invoices: StripeInvoice[];
}
export interface BillingClientRef {
  id: string;
  name: string;
  aliases?: string[];
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** The sign-up date entered on the record, if any. */
  signupDate?: string | null;
}
export interface StripeLinkRow {
  clientId: string;
  customerId: string;
  subscriptionId: string | null;
  excluded: boolean;
}

export type ClaimSource = "linked" | "record" | "subscription" | "name match" | "created by the OS";

export interface SubscriptionView {
  id: string;
  customer: string;
  status: string;
  collectionPaused: boolean;
  /** "$750.00 every 14 days". */
  amount: number;
  every: string;
  monthly: number;
  created: string;
  canceled: string | null;
  nextCharge: string | null;
  current: boolean;
  source: ClaimSource;
}
export interface ClientBilling {
  clientId: string;
  subscriptions: SubscriptionView[];
  current: string | null;
  mrr: number;
  totalSpend: number;
  transactions: number;
  signupDate: string | null;
  signupSource: "first $1 charge" | "entered" | "first charge" | null;
  customers: { id: string; name: string | null; source: ClaimSource; shared: boolean }[];
  /** Open invoices on the client's subscriptions/customers that Stripe failed to collect. */
  failedInvoices: StripeInvoice[];
}

const DAY = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);
/** Eastern calendar day — billing days are the business's days. */
const etDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));

/** Name key for matching customers to clients: lower-case letters/digits, minus card/company noise. */
export function customerKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\((?:\d+(?:st|nd|rd|th)\s+)?card\)|\bold\b|\bllc\b|\binc\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function every(it: StripeSubscription["items"][number]): string {
  const unit = it.interval === "day" ? "day" : it.interval === "week" ? "week" : it.interval === "month" ? "month" : it.interval;
  return it.intervalCount === 1 ? `every ${unit}` : `every ${it.intervalCount} ${unit}s`;
}

const isLive = (s: StripeSubscription) => ["active", "past_due"].includes(s.status) && !s.pause;

export function subscriptionMonthly(s: StripeSubscription): number {
  let m = 0;
  for (const it of s.items) m += monthlyAmount(it.amount * it.quantity, it.interval, it.intervalCount) * (1 - s.percentOff / 100);
  return m;
}

/** Every client's billing, from one account snapshot. */
export function buildBilling(
  clients: BillingClientRef[],
  snap: AccountSnapshot,
  links: StripeLinkRow[],
): Map<string, ClientBilling> {
  const subById = new Map(snap.subscriptions.map((s) => [s.id, s]));
  const custById = new Map(snap.customers.map((c) => [c.id, c]));
  const excluded = new Set(links.filter((l) => l.excluded).map((l) => `${l.clientId}|${l.customerId}|${l.subscriptionId ?? ""}`));
  const isExcluded = (clientId: string, customerId: string, subId: string | null = null) =>
    excluded.has(`${clientId}|${customerId}|${subId ?? ""}`) || (subId !== null && excluded.has(`${clientId}|${customerId}|`));

  // --- subscription owners
  const subOwner = new Map<string, { clientId: string; source: ClaimSource }>();
  for (const l of links) if (!l.excluded && l.subscriptionId) subOwner.set(l.subscriptionId, { clientId: l.clientId, source: "linked" });
  for (const c of clients) {
    const sid = c.stripeSubscriptionId;
    if (sid && !subOwner.has(sid) && !isExcluded(c.id, subById.get(sid)?.customer ?? "", sid)) subOwner.set(sid, { clientId: c.id, source: "record" });
  }
  for (const s of snap.subscriptions) {
    if (s.osClientId && !subOwner.has(s.id) && clients.some((c) => c.id === s.osClientId)) subOwner.set(s.id, { clientId: s.osClientId, source: "created by the OS" });
  }

  // --- customer claims
  const claims = new Map<string, Map<string, ClaimSource>>(); // customer → client → source
  const claim = (customerId: string | null | undefined, clientId: string, source: ClaimSource) => {
    if (!customerId || isExcluded(clientId, customerId)) return;
    const m = claims.get(customerId) ?? new Map<string, ClaimSource>();
    if (!m.has(clientId)) m.set(clientId, source);
    claims.set(customerId, m);
  };
  for (const l of links) if (!l.excluded && !l.subscriptionId) claim(l.customerId, l.clientId, "linked");
  for (const c of clients) claim(c.stripeCustomerId ?? (c.stripeSubscriptionId ? subById.get(c.stripeSubscriptionId)?.customer : null), c.id, "record");
  for (const [sid, o] of subOwner) claim(subById.get(sid)?.customer, o.clientId, "subscription");
  // Name matches: a customer nobody has claimed yet, named after exactly one client.
  for (const cust of snap.customers) {
    if (claims.has(cust.id)) continue;
    const key = customerKey(cust.name);
    if (key.length < 5) continue;
    const hits = clients.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => {
      const k = customerKey(n);
      return k.length >= 5 && (key === k || key.startsWith(k));
    }));
    if (hits.length === 1) claim(cust.id, hits[0].id, "name match");
  }

  // --- the primary claimant of a shared customer: first on it
  const primary = new Map<string, string>();
  for (const [custId, m] of claims) {
    const ids = [...m.keys()];
    if (ids.length === 1) { primary.set(custId, ids[0]); continue; }
    const firstSub = (clientId: string) => Math.min(...snap.subscriptions
      .filter((s) => s.customer === custId && subOwner.get(s.id)?.clientId === clientId).map((s) => s.created), Number.MAX_SAFE_INTEGER);
    primary.set(custId, ids.sort((a, b) => firstSub(a) - firstSub(b))[0]);
  }

  // --- who each subscription and each charge belongs to
  const subClient = (s: StripeSubscription): string | null => subOwner.get(s.id)?.clientId ?? primary.get(s.customer) ?? null;
  const chargeClient = (ch: StripeCharge): string | null => {
    if (ch.subscription) {
      const s = subById.get(ch.subscription);
      if (s) return subClient(s);
    }
    return ch.customer ? primary.get(ch.customer) ?? null : null;
  };

  const out = new Map<string, ClientBilling>();
  for (const c of clients) {
    const mine = snap.subscriptions.filter((s) => subClient(s) === c.id).sort((a, b) => b.created - a.created);
    const current = mine.find((s) => s.status !== "canceled" && s.status !== "incomplete_expired") ?? mine[0] ?? null;
    const charges = snap.charges.filter((ch) => ch.status === "succeeded" && chargeClient(ch) === c.id);
    const firstDollar = charges.filter((ch) => Math.round(ch.amount * 100) === 100).sort((a, b) => a.created - b.created)[0];
    const firstAny = [...charges].sort((a, b) => a.created - b.created)[0];
    const entered = (c.signupDate ?? "").slice(0, 10) || null;
    const myCustomers = [...claims.entries()].filter(([, m]) => m.has(c.id));
    out.set(c.id, {
      clientId: c.id,
      subscriptions: mine.map((s) => ({
        id: s.id,
        customer: s.customer,
        status: s.status,
        collectionPaused: !!s.pause,
        amount: cents(s.items.reduce((t, it) => t + it.amount * it.quantity, 0)),
        every: s.items[0] ? every(s.items[0]) : "",
        monthly: cents(subscriptionMonthly(s)),
        created: etDay(s.created),
        canceled: DAY(s.canceledAt),
        nextCharge: isLive(s) && s.periodEnd ? etDay(s.periodEnd) : s.pause?.resumesAt ? etDay(s.pause.resumesAt) : null,
        current: s.id === current?.id,
        source: subOwner.get(s.id)?.source ?? "subscription",
      })),
      current: current?.id ?? null,
      mrr: cents(mine.filter(isLive).reduce((t, s) => t + subscriptionMonthly(s), 0)),
      totalSpend: cents(charges.reduce((t, ch) => t + ch.amount - ch.refunded, 0)),
      transactions: charges.length,
      signupDate: firstDollar ? etDay(firstDollar.created) : entered ?? (firstAny ? etDay(firstAny.created) : null),
      signupSource: firstDollar ? "first $1 charge" : entered ? "entered" : firstAny ? "first charge" : null,
      customers: myCustomers.map(([id, m]) => ({ id, name: custById.get(id)?.name ?? null, source: m.get(c.id)!, shared: m.size > 1 })),
      failedInvoices: snap.invoices.filter((inv) =>
        inv.status === "open" && inv.attemptCount > 0 &&
        ((inv.subscription && subById.get(inv.subscription) && subClient(subById.get(inv.subscription)!) === c.id) ||
         (!inv.subscription && primary.get(inv.customer) === c.id))),
    });
  }
  return out;
}

/* ------------------------------------------------------------- the business --- */

export interface BillingTotals {
  /** Everything ever collected, less refunds — every successful charge in the account. */
  totalBilled: number;
  /** …of which not attributable to any client (named in the UI, never hidden). */
  unattributed: number;
  mrr: number;
  arr: number;
  activeSubscriptions: number;
  pausedSubscriptions: number;
  /** Collected this calendar month and last, and the change. */
  collectedThisMonth: number;
  collectedLastMonth: number;
  /** Same days of last month, so a half-month is compared with a half-month. */
  collectedLastMonthToDate: number;
  growthPct: number | null;
  /** MRR started and stopped in the last 30 days. */
  newMrr30: number;
  lostMrr30: number;
}

export function billingTotals(snap: AccountSnapshot, perClient: Map<string, ClientBilling>, now = Date.now()): BillingTotals {
  const ok = snap.charges.filter((c) => c.status === "succeeded");
  const totalBilled = cents(ok.reduce((t, c) => t + c.amount - c.refunded, 0));
  const attributed = cents([...perClient.values()].reduce((t, b) => t + b.totalSpend, 0));
  const live = snap.subscriptions.filter((s) => !["canceled", "incomplete_expired"].includes(s.status));
  const month = (t: number) => etDay(t).slice(0, 7);
  const thisMonth = etDay(now / 1000).slice(0, 7);
  const d = new Date(`${thisMonth}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const lastMonth = d.toISOString().slice(0, 7);
  const dayOfMonth = Number(etDay(now / 1000).slice(8, 10));
  const sum = (f: (c: StripeCharge) => boolean) => cents(ok.filter(f).reduce((t, c) => t + c.amount - c.refunded, 0));
  const collectedThisMonth = sum((c) => month(c.created) === thisMonth);
  const collectedLastMonth = sum((c) => month(c.created) === lastMonth);
  const collectedLastMonthToDate = sum((c) => month(c.created) === lastMonth && Number(etDay(c.created).slice(8, 10)) <= dayOfMonth);
  const since = now / 1000 - 30 * 86_400;
  const mrr = cents(snap.subscriptions.filter(isLive).reduce((t, s) => t + subscriptionMonthly(s), 0));
  return {
    totalBilled,
    unattributed: cents(totalBilled - attributed),
    mrr,
    arr: cents(mrr * 12),
    activeSubscriptions: live.filter((s) => isLive(s)).length,
    pausedSubscriptions: live.filter((s) => !!s.pause).length,
    collectedThisMonth,
    collectedLastMonth,
    collectedLastMonthToDate,
    growthPct: collectedLastMonthToDate > 0 ? Math.round(((collectedThisMonth - collectedLastMonthToDate) / collectedLastMonthToDate) * 1000) / 10 : null,
    newMrr30: cents(snap.subscriptions.filter((s) => s.created >= since && isLive(s)).reduce((t, s) => t + subscriptionMonthly(s), 0)),
    lostMrr30: cents(snap.subscriptions.filter((s) => s.canceledAt && s.canceledAt >= since).reduce((t, s) => t + subscriptionMonthly(s), 0)),
  };
}

export interface UpcomingCharge { date: string; clientId: string | null; subscription: string; amount: number; every: string }

/** The billing calendar: each live subscription's next charges in the window (cycles repeat inside it). */
export function upcomingCharges(snap: AccountSnapshot, perClient: Map<string, ClientBilling>, days = 30, now = Date.now()): UpcomingCharge[] {
  const owner = new Map<string, string>();
  for (const b of perClient.values()) for (const s of b.subscriptions) owner.set(s.id, b.clientId);
  const end = now / 1000 + days * 86_400;
  const out: UpcomingCharge[] = [];
  for (const s of snap.subscriptions) {
    if (!isLive(s) || !s.periodEnd || !s.items[0]) continue;
    const it = s.items[0];
    const stepDays = it.interval === "day" ? it.intervalCount : it.interval === "week" ? 7 * it.intervalCount : null;
    let t = s.periodEnd;
    for (let i = 0; i < 12 && t <= end; i++) {
      if (t >= now / 1000 - 86_400) out.push({ date: etDay(t), clientId: owner.get(s.id) ?? null, subscription: s.id, amount: cents(s.items.reduce((a, x) => a + x.amount * x.quantity, 0) * (1 - s.percentOff / 100)), every: every(it) });
      if (stepDays) t += stepDays * 86_400;
      else { const d = new Date(t * 1000); d.setUTCMonth(d.getUTCMonth() + (it.interval === "year" ? 12 : 1) * it.intervalCount); t = d.getTime() / 1000; }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

export { AVG_MONTH_DAYS };
