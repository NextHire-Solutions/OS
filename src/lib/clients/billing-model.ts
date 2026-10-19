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
  items: { amount: number; interval: string; intervalCount: number; quantity: number; product?: string | null }[];
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
  /* For the Billing tab (19 Oct). */
  description?: string | null;
  /** The invoice the charge paid, through invoice_payments. */
  invoice?: string | null;
  /** "Visa •••• 4242". */
  card?: string | null;
  hasReceipt?: boolean;
}
export interface StripeRefund {
  id: string;
  charge: string | null;
  /** Dollars. */
  amount: number;
  created: number;
  status: string;
  reason: string | null;
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
  /* For the Billing tab (19 Oct). */
  total?: number;
  amountPaid?: number;
  pdf?: string | null;
  paidAt?: number | null;
  periodStart?: number | null;
  periodEnd?: number | null;
  /** The first line's description: "1 × RECRUITING SERVICES (at $750.00 / every 14 days)". */
  description?: string | null;
}
export interface AccountSnapshot {
  customers: StripeCustomer[];
  subscriptions: StripeSubscription[];
  charges: StripeCharge[];
  invoices: StripeInvoice[];
  /* For the Billing tab (19 Oct). */
  refunds?: StripeRefund[];
  products?: { id: string; name: string }[];
  /** When Stripe was read (ms). */
  readAt?: number;
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

/** A day- or week-based interval in days; null for months and years, which are not a fixed number of days. */
function stepDaysOf(it: StripeSubscription["items"][number]): number | null {
  if (it.interval === "day") return it.intervalCount;
  if (it.interval === "week") return 7 * it.intervalCount;
  return null;
}

const isLive = (s: StripeSubscription) => ["active", "past_due"].includes(s.status) && !s.pause;

export function subscriptionMonthly(s: StripeSubscription): number {
  let m = 0;
  for (const it of s.items) m += monthlyAmount(it.amount * it.quantity, it.interval, it.intervalCount) * (1 - s.percentOff / 100);
  return m;
}

/*
 * WHO OWNS EACH SUBSCRIPTION AND EACH CHARGE — the rules in this file's header,
 * resolved once. `buildBilling` reads it for each client's figures; the
 * Performance page (13 Oct) reads the same answer for the subscriptions list,
 * the charges tied to nobody and how long each client has paid, so those three
 * can never disagree with the per-client totals about whose money is whose.
 */
function resolveOwnership(
  clients: BillingClientRef[],
  snap: AccountSnapshot,
  links: StripeLinkRow[],
) {
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

  return { subById, custById, subOwner, claims, primary, subClient, chargeClient };
}

/** Every client's billing, from one account snapshot. */
export function buildBilling(
  clients: BillingClientRef[],
  snap: AccountSnapshot,
  links: StripeLinkRow[],
): Map<string, ClientBilling> {
  const { subById, custById, subOwner, claims, primary, subClient, chargeClient } = resolveOwnership(clients, snap, links);

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

/* ------------------------------------------------ the Billing tab (19 Oct) --- */

/*
 * Eddy, 17 Oct: "a centralized Billing section for each client" — current
 * billing, total billed, every past charge including failed payments and
 * refunds, and every invoice to view and download, "synced with Stripe".
 *
 * Read from the same snapshot by the same ownership rules as `buildBilling`,
 * so the tab's total is the client's Total spend to the cent, and a shared
 * card's payments are split the same way everywhere.
 */

export type PayState =
  | "paid" | "failed" | "past_due" | "open" | "uncollectible" | "paused" | "cancelled" | "trial" | "incomplete" | "collecting";
export type BillingTone = "good" | "warn" | "bad" | "mute";

export interface BillingNowView {
  subscriptionId: string;
  /** The Stripe product: "RECRUITING SERVICES", "Recruiting Services - Minimum Tier". */
  product: string | null;
  /** What each charge is, after any discount. */
  amount: number;
  /** Before the discount, when there is one. */
  listAmount: number | null;
  percentOff: number;
  every: string;
  /** The next charge (collecting), or the day collection resumes (paused). Eastern day. */
  nextBilling: string | null;
  since: string;
  canceled: string | null;
  state: PayState;
  tone: BillingTone;
  /** Owed on invoices Stripe failed to collect, and how many. */
  unpaid: number;
  failedInvoices: number;
  /** What the open invoice asks for, when the latest is open but not yet tried. */
  due: number | null;
}

export interface BillingHistoryRow {
  /** ch_… for a payment, re_… for a refund. */
  id: string;
  kind: "payment" | "failed" | "pending" | "refund";
  date: string;
  at: number;
  /** Dollars, always positive — `kind` says which way it went. */
  amount: number;
  description: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  card: string | null;
  /** Why it failed, why it was refunded, "Refunded in full"… */
  note: string | null;
  /** A Stripe receipt can be opened (a successful payment). */
  receipt: boolean;
  /** A refund: the payment it gave back. */
  chargeId?: string;
}

export interface BillingInvoiceRow {
  id: string;
  number: string | null;
  date: string;
  at: number;
  status: string;
  label: string;
  tone: BillingTone;
  total: number;
  paid: number;
  remaining: number;
  description: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidOn: string | null;
  attempts: number;
  /** Can be viewed (Stripe's invoice page) / downloaded (the PDF). A draft can do neither. */
  page: boolean;
  pdf: boolean;
}

export interface ClientBillingDetail {
  clientId: string;
  /** The current subscription; null when the client has none in Stripe. */
  now: BillingNowView | null;
  subscriptions: number;
  /** Subscriptions besides the current one that are not cancelled. */
  otherLive: number;
  totals: {
    /** Paid, less refunds — the client's Total spend. */
    net: number;
    /** Every successful payment, before refunds. */
    charged: number;
    refunded: number;
    payments: number;
    failed: number;
    /** Still owed on open invoices. */
    unpaid: number;
    firstPayment: string | null;
    lastPayment: { date: string; amount: number } | null;
  };
  /** Newest first. */
  history: BillingHistoryRow[];
  /** Newest first. */
  invoices: BillingInvoiceRow[];
  /** When Stripe was read (ms). */
  readAt: number | null;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const REFUND_REASON: Record<string, string> = {
  duplicate: "Duplicate payment",
  requested_by_customer: "Requested by the client",
  fraudulent: "Fraudulent",
  expired_uncaptured_charge: "Expired",
};

/** Stripe's invoice line, without the "1 × " of a single item. */
export function lineText(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t ? t.replace(/^1\s*×\s*/, "") : null;
}

function invoiceLook(inv: StripeInvoice): { label: string; tone: BillingTone } {
  if (inv.status === "paid") return { label: "Paid", tone: "good" };
  if (inv.status === "open") return inv.attemptCount > 0 ? { label: "Payment failed", tone: "bad" } : { label: "Open", tone: "warn" };
  if (inv.status === "uncollectible") return { label: "Uncollectible", tone: "bad" };
  if (inv.status === "void") return { label: "Void", tone: "mute" };
  if (inv.status === "draft") return { label: "Draft", tone: "mute" };
  return { label: inv.status, tone: "mute" };
}

/** One client's Billing tab. Null when the client is not in `clients`. */
export function clientBillingDetail(
  clients: BillingClientRef[],
  snap: AccountSnapshot,
  links: StripeLinkRow[],
  clientId: string,
): ClientBillingDetail | null {
  if (!clients.some((c) => c.id === clientId)) return null;
  const b = buildBilling(clients, snap, links).get(clientId)!;
  const { subById, primary, subClient, chargeClient } = resolveOwnership(clients, snap, links);
  const product = new Map((snap.products ?? []).map((p) => [p.id, p.name]));

  // --- the invoices, by the rule failedInvoices uses: the subscription's owner, else the customer's first client
  const invoiceOwner = (inv: StripeInvoice): string | null => {
    const s = inv.subscription ? subById.get(inv.subscription) : undefined;
    return s ? subClient(s) : primary.get(inv.customer) ?? null;
  };
  const myInvoices = snap.invoices.filter((inv) => invoiceOwner(inv) === clientId).sort((a, b2) => b2.created - a.created || a.id.localeCompare(b2.id));
  const invoiceById = new Map(snap.invoices.map((i) => [i.id, i]));

  // --- payments, failed payments and refunds
  const myCharges = snap.charges.filter((ch) => chargeClient(ch) === clientId);
  const chargeById = new Map(myCharges.map((ch) => [ch.id, ch]));
  const history: BillingHistoryRow[] = [];
  const describe = (ch: StripeCharge) => {
    const inv = ch.invoice ? invoiceById.get(ch.invoice) : undefined;
    return lineText(inv?.description) ?? lineText(ch.description) ?? "Payment";
  };
  for (const ch of myCharges) {
    const inv = ch.invoice ? invoiceById.get(ch.invoice) : undefined;
    const kind = ch.status === "succeeded" ? "payment" : ch.status === "failed" ? "failed" : "pending";
    const note = kind === "failed" ? ch.failureMessage || "The payment failed"
      : kind === "pending" ? "Processing"
      : ch.refunded > 0 ? (cents(ch.refunded) >= cents(ch.amount) ? "Refunded in full" : `${usd(ch.refunded)} refunded`)
      : null;
    history.push({
      id: ch.id, kind, date: etDay(ch.created), at: ch.created, amount: cents(ch.amount), description: describe(ch),
      invoiceId: inv?.id ?? null, invoiceNumber: inv?.number ?? null, card: ch.card ?? null, note,
      receipt: kind === "payment" && ch.hasReceipt === true,
    });
  }
  for (const r of snap.refunds ?? []) {
    const ch = r.charge ? chargeById.get(r.charge) : undefined;
    if (!ch) continue;
    const inv = ch.invoice ? invoiceById.get(ch.invoice) : undefined;
    const why = r.reason ? REFUND_REASON[r.reason] ?? r.reason : null;
    const state = r.status === "succeeded" ? null : r.status === "pending" ? "Processing" : r.status === "failed" ? "Refund failed" : r.status === "canceled" ? "Refund cancelled" : r.status;
    history.push({
      id: r.id, kind: "refund", date: etDay(r.created), at: r.created, amount: cents(r.amount), description: describe(ch),
      invoiceId: inv?.id ?? null, invoiceNumber: inv?.number ?? null, card: ch.card ?? null,
      note: [why, state].filter(Boolean).join(" · ") || null, receipt: false, chargeId: ch.id,
    });
  }
  history.sort((a, c) => c.at - a.at || a.id.localeCompare(c.id));

  // --- the totals: the same charges and the same sum as Total spend
  const ok = myCharges.filter((ch) => ch.status === "succeeded").sort((a, c) => a.created - c.created);
  const last = ok[ok.length - 1];
  const unpaid = cents(myInvoices.filter((i) => i.status === "open").reduce((t, i) => t + i.amountRemaining, 0));

  // --- what the client is on now
  const cur = b.current ? subById.get(b.current) ?? null : null;
  let now: BillingNowView | null = null;
  if (cur) {
    const view = b.subscriptions.find((s) => s.id === cur.id)!;
    const gross = cur.items.reduce((t, it) => t + it.amount * it.quantity, 0);
    const failedUnpaid = cents(b.failedInvoices.reduce((t, i) => t + i.amountRemaining, 0));
    const latest = myInvoices.find((i) => i.subscription === cur.id && i.status !== "draft" && i.status !== "void");
    const ended = cur.status === "canceled" || cur.status === "incomplete_expired";
    const [state, tone]: [PayState, BillingTone] =
      ended ? ["cancelled", "mute"]
      : cur.pause ? ["paused", "warn"]
      : b.failedInvoices.length ? ["failed", "bad"]
      : cur.status === "past_due" || cur.status === "unpaid" ? ["past_due", "bad"]
      : cur.status === "incomplete" ? ["incomplete", "bad"]
      : cur.status === "trialing" ? ["trial", "mute"]
      : latest?.status === "paid" ? ["paid", "good"]
      : latest?.status === "open" ? ["open", "warn"]
      : latest?.status === "uncollectible" ? ["uncollectible", "bad"]
      : ["collecting", "good"];
    now = {
      subscriptionId: cur.id,
      product: product.get(cur.items[0]?.product ?? "") ?? null,
      amount: cents(gross * (1 - cur.percentOff / 100)),
      listAmount: cur.percentOff ? cents(gross) : null,
      percentOff: cur.percentOff,
      every: view.every,
      nextBilling: ended ? null : view.nextCharge,
      since: view.created,
      canceled: view.canceled,
      state,
      tone,
      unpaid: failedUnpaid,
      failedInvoices: b.failedInvoices.length,
      due: state === "open" && latest ? cents(latest.amountRemaining) : null,
    };
  }

  return {
    clientId,
    now,
    subscriptions: b.subscriptions.length,
    otherLive: b.subscriptions.filter((s) => s.id !== b.current && !["canceled", "incomplete_expired"].includes(s.status)).length,
    totals: {
      net: b.totalSpend,
      charged: cents(ok.reduce((t, ch) => t + ch.amount, 0)),
      refunded: cents(ok.reduce((t, ch) => t + ch.refunded, 0)),
      payments: ok.length,
      failed: myCharges.filter((ch) => ch.status === "failed").length,
      unpaid,
      firstPayment: ok[0] ? etDay(ok[0].created) : null,
      lastPayment: last ? { date: etDay(last.created), amount: cents(last.amount) } : null,
    },
    history,
    invoices: myInvoices.map((inv) => {
      const look = invoiceLook(inv);
      const total = inv.total ?? inv.amountDue;
      return {
        id: inv.id, number: inv.number, date: etDay(inv.created), at: inv.created, status: inv.status, label: look.label, tone: look.tone,
        total: cents(total),
        paid: cents(inv.amountPaid ?? (inv.status === "paid" ? total : 0)),
        remaining: cents(inv.amountRemaining),
        description: lineText(inv.description),
        periodStart: inv.periodStart ? etDay(inv.periodStart) : null,
        periodEnd: inv.periodEnd ? etDay(inv.periodEnd) : null,
        paidOn: inv.paidAt ? etDay(inv.paidAt) : null,
        attempts: inv.attemptCount,
        page: inv.status !== "draft" && !!inv.url,
        pdf: inv.status !== "draft" && !!inv.pdf,
      };
    }),
    readAt: snap.readAt ?? null,
  };
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

/* ------------------------------------------- the Performance page (13 Oct) --- */

/** One live or paused subscription, for the list behind "Active subs" / "Paused subs". */
export interface SubscriptionRow {
  id: string;
  /** Collecting now, or paused (collection paused, not cancelled). */
  state: "active" | "paused";
  customerId: string;
  /** The client it belongs to, or null when no client is tied to it. */
  clientId: string | null;
  /** The Stripe customer's name — what is shown when there is no client. */
  customerName: string | null;
  /** Stripe's monthly figure for this subscription (what MRR adds up). */
  mrr: number;
  amount: number;
  every: string;
  /** The interval in days (14, 28…); null when it is month- or year-based. For billing-align.ts. */
  stepDays: number | null;
  /** Next charge (active) — Eastern day. */
  nextCharge: string | null;
  /** When collection resumes (paused), if a date is set — Eastern day. */
  resumes: string | null;
}

/*
 * The subscriptions the two tiles count, one row each — the SAME two filters
 * as `billingTotals` (isLive; paused and not cancelled), so the list a tile
 * opens always has exactly as many rows as the number on the tile.
 */
export function subscriptionRows(clients: BillingClientRef[], snap: AccountSnapshot, links: StripeLinkRow[]): SubscriptionRow[] {
  const { custById, subClient } = resolveOwnership(clients, snap, links);
  const rows: SubscriptionRow[] = [];
  for (const s of snap.subscriptions) {
    if (["canceled", "incomplete_expired"].includes(s.status)) continue;
    const state = isLive(s) ? "active" : s.pause ? "paused" : null;
    if (!state) continue; // trialing, unpaid, incomplete: counted by neither tile
    rows.push({
      id: s.id,
      state,
      customerId: s.customer,
      clientId: subClient(s),
      customerName: custById.get(s.customer)?.name ?? null,
      mrr: cents(subscriptionMonthly(s)),
      amount: cents(s.items.reduce((t, it) => t + it.amount * it.quantity, 0) * (1 - s.percentOff / 100)),
      every: s.items[0] ? every(s.items[0]) : "",
      stepDays: s.items[0] ? stepDaysOf(s.items[0]) : null,
      nextCharge: state === "active" && s.periodEnd ? etDay(s.periodEnd) : null,
      resumes: state === "paused" && s.pause?.resumesAt ? etDay(s.pause.resumesAt) : null,
    });
  }
  return rows.sort((a, b) => b.mrr - a.mrr || a.id.localeCompare(b.id));
}

/** Money collected that no client is tied to, by the Stripe customer it came from. */
export interface UnattributedCustomer {
  customerId: string | null;
  name: string | null;
  email: string | null;
  /** Collected from them, less refunds. */
  amount: number;
  charges: number;
  first: string;
  last: string;
}

/*
 * "$6,624 not tied to a client — can you tell us what these are?" (13 Oct).
 *
 * Every successful charge `buildBilling` gives to no client, grouped by the
 * Stripe customer that paid. It adds up to `billingTotals().unattributed`
 * exactly, because it is the same charges by the same rule.
 */
export function unattributedByCustomer(clients: BillingClientRef[], snap: AccountSnapshot, links: StripeLinkRow[]): UnattributedCustomer[] {
  const { custById, chargeClient } = resolveOwnership(clients, snap, links);
  const known = new Set(clients.map((c) => c.id));
  const by = new Map<string, UnattributedCustomer & { firstT: number; lastT: number }>();
  for (const ch of snap.charges) {
    if (ch.status !== "succeeded") continue;
    const owner = chargeClient(ch);
    if (owner && known.has(owner)) continue;
    const key = ch.customer ?? "";
    const cust = ch.customer ? custById.get(ch.customer) : undefined;
    const e = by.get(key) ?? { customerId: ch.customer, name: cust?.name ?? null, email: cust?.email ?? null, amount: 0, charges: 0, first: "", last: "", firstT: Infinity, lastT: -Infinity };
    e.amount += ch.amount - ch.refunded;
    e.charges += 1;
    if (ch.created < e.firstT) { e.firstT = ch.created; e.first = etDay(ch.created); }
    if (ch.created > e.lastT) { e.lastT = ch.created; e.last = etDay(ch.created); }
    by.set(key, e);
  }
  return [...by.values()]
    .map(({ firstT: _f, lastT: _l, ...rest }) => ({ ...rest, amount: cents(rest.amount) }))
    .sort((a, b) => b.amount - a.amount || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** A billing interval, in months (Stripe's average month). */
function intervalMonths(interval: string, count: number): number {
  if (interval === "day") return count / AVG_MONTH_DAYS;
  if (interval === "week") return (7 * count) / AVG_MONTH_DAYS;
  if (interval === "year") return 12 * count;
  return count;
}

/*
 * How long each client has paid, in months — "customer lifespan".
 *
 * The wireframe's definition: "count of paid monthly invoices per client".
 * Most clients are not billed monthly but every 14 days, so a paid invoice is
 * counted for the period it paid for: a 14-day invoice is 0.46 of a month, a
 * monthly one is 1. Two fortnightly invoices and one monthly invoice are then
 * the same lifespan, which is what the figure is for.
 *
 * Only money paid on a subscription counts — the $1 card check at sign-up and
 * one-off payments are not a period of service — and a charge refunded in
 * full does not count. A client with no such charge is absent from the map.
 */
export function monthsPaidByClient(clients: BillingClientRef[], snap: AccountSnapshot, links: StripeLinkRow[]): Map<string, number> {
  const { subById, chargeClient } = resolveOwnership(clients, snap, links);
  const out = new Map<string, number>();
  for (const ch of snap.charges) {
    if (ch.status !== "succeeded" || !ch.subscription || ch.amount - ch.refunded <= 0) continue;
    const owner = chargeClient(ch);
    const it = subById.get(ch.subscription)?.items[0];
    if (!owner || !it) continue;
    out.set(owner, (out.get(owner) ?? 0) + intervalMonths(it.interval, it.intervalCount));
  }
  for (const [k, v] of out) out.set(k, Math.round(v * 100) / 100);
  return out;
}

/** Collected per Eastern day, less refunds — every successful charge in the account. */
export function revenueByDay(snap: AccountSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const ch of snap.charges) {
    if (ch.status !== "succeeded") continue;
    const day = etDay(ch.created);
    out.set(day, (out.get(day) ?? 0) + ch.amount - ch.refunded);
  }
  for (const [k, v] of out) out.set(k, cents(v));
  return out;
}

export { AVG_MONTH_DAYS };
