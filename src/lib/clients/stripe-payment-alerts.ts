/*
 * NEW PAYMENTS → THE BELL — the rule, with no Stripe or database attached (6 Nov).
 *
 * Eddy: "how can [we] easily identify customers' ID, new customers and subscriptions?" The user's answer to how: a payment
 * never creates a client — clients are only made with Onboard client — and after onboarding the OS finds the client's
 * Stripe customer "using email or anything", checking Stripe every 5 minutes; and (after three reviews) what it finds by
 * email counts only once a person confirms it, with one click on the client's Billing tab.
 *
 * Who owns what is billing-model.ts's (a link, the record, an owned subscription, an automatic name match), and what is
 * found by email is its emailSuggestions. This says what the bell tells the billing people, each thing once (the ref is
 * unique):
 *
 *   stripe_payment_unmatched   A Checkout paid in the last two days that no client has, and that no client's email
 *                              finds: who paid, what, the ids, and how to tie it.
 *   stripe_found               A customer found by email for a client, not counted until someone confirms it there.
 *   stripe_counted             A customer counted by an automatic NAME match, while the customer or the client is new.
 *   stripe_new_subscription    A subscription started in the last two days and counted for a client — unless its
 *                              customer's "counted" alert named it already, in this pass or an earlier one.
 *   stripe_no_customer         A client onboarded in the last week that nothing in Stripe matches or finds, while payments
 *                              no client has are waiting: those payments, for a person to link the right one.
 *
 * Name matches older than 30 days (customer and client both) were made before the bell said them, and say nothing.
 */

import { domainHint, matchEmailKey, type AccountSnapshot, type BillingClientRef, type ClientBilling, type EmailSuggestion } from "./billing-model.ts";

export const PAYMENT_ALERT_KINDS = ["stripe_payment_unmatched", "stripe_found", "stripe_counted", "stripe_new_subscription", "stripe_no_customer"] as const;
export type PaymentAlertKind = (typeof PAYMENT_ALERT_KINDS)[number];

/** Payments looked at: Checkouts this recent. A subscription this new is new. */
export const RECENT_PAYMENT_MS = 2 * 86_400_000;
/** A customer or client this new has its name matches said; a payment no client has this new is a candidate. */
export const NEW_FOR_MS = 30 * 86_400_000;
/** A client onboarded this recently, with nothing found for it, is said. */
export const ONBOARDED_RECENTLY_MS = 7 * 86_400_000;
/*
 * …once it has been on the books this long: onboarding saves the sign-in list and the Stripe subscription after the client
 * itself, so a pass in the first minutes could miss what is about to be added.
 */
export const SETTLE_MS = 15 * 60_000;

/** A paid Checkout, as the bell needs it. */
export interface PaidCheckout {
  id: string;
  /** Unix seconds. */
  created: number;
  customer: string | null;
  email: string | null;
  name: string | null;
  /** Dollars. */
  amount: number;
  mode: string;
  subscription: string | null;
  /** The questions the payment link asked, answered. */
  answers: Array<{ label: string; value: string }>;
}

/** A client as the alerts need it: billing's own view (billing-account.ts), with the addresses its suggestions used. */
export type AlertClient = Pick<BillingClientRef, "id" | "name" | "emails" | "internal" | "createdAt" | "status">;

export interface PaymentAlert {
  kind: PaymentAlertKind;
  severity: "info" | "warning";
  title: string;
  body: string;
  clientId: string | null;
  ref: string;
}

/** Statuses a client can be onboarded into and still be waiting on its first payment. */
const STILL_STARTING = new Set(["onboarding", "active"]);
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(ms));
const payer = (c: { name: string | null; email: string | null }) => (c.name && c.email ? `${c.name} (${c.email})` : c.name ?? c.email ?? "an unnamed payer");
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const subStatus = (s: { status: string; pause: unknown; canceledAt?: number | null }) =>
  s.status === "canceled" || s.status === "incomplete_expired" ? "cancelled" : s.pause ? "paused" : s.status === "past_due" ? "past due" : "collecting";

export function paymentAlerts(input: {
  checkouts: PaidCheckout[];
  clients: AlertClient[];
  byClient: Map<string, ClientBilling>;
  snapshot: Pick<AccountSnapshot, "customers" | "subscriptions" | "charges" | "readAt">;
  /** Found by email, not counted (billing-model.ts emailSuggestions). */
  suggestions?: EmailSuggestion[];
  now: number;
  /** Refs already in the bell: what was said before is not repeated, and what it said is known. */
  said?: ReadonlySet<string>;
  /** Subscriptions a "counted" alert already in the bell named: not said again as new. */
  named?: ReadonlySet<string>;
  /** "client|customer" for each Not this client / Not theirs (billing-model.ts excludedPairs): no hint names that client. */
  excluded?: ReadonlySet<string>;
  /*
   * Clients a "Payment from X, not on their Billing tab" alert already in the bell names (a payment Stripe kept no
   * customer for, from an address on X): told about that payment for good, since it can never be linked elsewhere.
   */
  paymentNamed?: ReadonlySet<string>;
}): PaymentAlert[] {
  const { checkouts, clients, byClient, snapshot, now } = input;
  const suggestions = input.suggestions ?? [];
  const said = input.said ?? new Set<string>();
  const named = input.named ?? new Set<string>();
  const excluded = input.excluded ?? new Set<string>();
  const out: PaymentAlert[] = [];
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const customerById = new Map(snapshot.customers.map((c) => [c.id, c]));
  const subById = new Map(snapshot.subscriptions.map((s) => [s.id, s]));
  const suggestedFor = new Map(suggestions.map((x) => [x.customerId, x.clientId]));
  // Who counts each customer and each subscription, as billing-model.ts decided.
  const customerOwners = new Map<string, string[]>();
  const subOwner = new Map<string, string>();
  for (const [clientId, b] of byClient) {
    for (const cu of b.customers) customerOwners.set(cu.id, [...(customerOwners.get(cu.id) ?? []), clientId]);
    for (const s of b.subscriptions) subOwner.set(s.id, clientId);
  }
  const paidBy = (customerId: string) =>
    snapshot.charges.filter((ch) => ch.customer === customerId && ch.status === "succeeded").reduce((sum, ch) => sum + ch.amount - ch.refunded, 0);
  // The company-domain hint, never for a client a person already said isn't this customer's.
  const hintId = (email: string | null, customerId: string | null) => {
    const id = domainHint(email, clients);
    return id && !(customerId && excluded.has(`${id}|${customerId}`)) ? id : null;
  };
  const hintFor = (email: string | null, customerId: string | null) => {
    const id = hintId(email, customerId);
    return id ? clientById.get(id) ?? null : null;
  };
  // A client a payment alert names, in this pass or one already in the bell: not also "no Stripe payment found" for it.
  const paidWithoutCustomer = new Set<string>(input.paymentNamed ?? []);

  // 1. Paid, no client has it, and no client's email finds it (that is said as found, in 2).
  for (const ch of checkouts) {
    if (now - ch.created * 1000 > RECENT_PAYMENT_MS) continue;
    // The copy of Stripe hasn't seen this customer or subscription yet, so who has it can't be told: a later pass says it.
    if ((ch.customer && !customerById.has(ch.customer)) || (ch.subscription && !subById.has(ch.subscription))) continue;
    const owner = (ch.subscription ? subOwner.get(ch.subscription) : undefined) ?? (ch.customer ? customerOwners.get(ch.customer)?.[0] : undefined);
    if (owner || (ch.customer && suggestedFor.has(ch.customer))) continue;
    const sub = ch.subscription ? subById.get(ch.subscription) : undefined;
    const it = sub?.items[0];
    const what = it ? `${usd(it.amount * it.quantity)} every ${it.intervalCount === 1 ? it.interval : `${it.intervalCount} ${it.interval}s`}` : `${usd(ch.amount)}${ch.mode === "payment" ? " one-time" : ""}`;
    // The payment link's questions are the team's own (brokerage or team, market): their answers alone read clearly.
    const answers = ch.answers.map((a) => a.value.trim()).filter(Boolean);
    const asked = answers.length ? ` Answered: ${answers.join(" · ")}.` : "";
    // Stripe kept no customer (a link set to make one only when it must): nothing can be linked, but the address may say whose it is.
    const email = matchEmailKey(ch.email);
    const byEmail = ch.customer || !email ? [] : clients.filter((c) => (c.emails ?? []).some((e) => matchEmailKey(e) === email));
    if (!ch.customer && byEmail.length === 1 && !byEmail[0].internal) {
      paidWithoutCustomer.add(byEmail[0].id);
      out.push({
        kind: "stripe_payment_unmatched", severity: "info", clientId: byEmail[0].id, ref: `stripe-unmatched:${ch.id}`,
        title: `Payment from ${byEmail[0].name}, not on their Billing tab`,
        body: `${what}, paid ${day(ch.created * 1000)} by ${payer(ch)}, who is on ${byEmail[0].name}.${asked} Stripe kept no customer, so it can't be counted on their Billing tab.`,
      });
      continue;
    }
    // With no Stripe customer nothing can be linked, so no client is hinted (or named for it).
    const hint = ch.customer ? hintFor(ch.email, ch.customer) : null;
    const ids = ch.customer ? ` Customer ${ch.customer}${ch.subscription ? `, subscription ${ch.subscription}` : ""}.` : "";
    const how = !ch.customer
      ? " Stripe kept no customer, so it can't be linked to a client."
      : hint
        ? ` Likely ${hint.name} (same email domain): if so, an admin can link ${ch.subscription ?? ch.customer} on their Billing tab.` +
          (ch.subscription ? ` If they're new, paste ${ch.subscription} into Stripe subscription in Onboard client.` : "")
        : ch.subscription
          ? ` If they're new, paste ${ch.subscription} into Stripe subscription in Onboard client; if not, an admin can link it on their Billing tab.`
          : ` Once they're onboarded the OS looks for it by email and asks to confirm it; or an admin can link ${ch.customer} on their Billing tab.`;
    if (hint) paidWithoutCustomer.add(hint.id);
    out.push({
      kind: "stripe_payment_unmatched", severity: "warning", clientId: hint?.id ?? null, ref: `stripe-unmatched:${ch.id}`,
      title: `New payment, no client yet: ${ch.name ?? ch.email ?? "unnamed payer"}`,
      body: `${what}, paid ${day(ch.created * 1000)} by ${payer(ch)}.${asked}${ids}${how}`,
    });
  }

  // 2. Found by email: for a person to confirm. Each once, whenever it is first found.
  for (const x of suggestions) {
    const c = clientById.get(x.clientId);
    const cu = customerById.get(x.customerId);
    if (!c || c.internal || !cu) continue;
    const subs = snapshot.subscriptions.filter((s) => s.customer === cu.id);
    const paid = paidBy(cu.id);
    out.push({
      kind: "stripe_found", severity: "info", clientId: c.id, ref: `stripe-found:${c.id}:${cu.id}`,
      title: `Stripe customer found for ${c.name}: confirm it`,
      body: `${payer(cu)}, customer ${cu.id}, has an email that is on ${c.name}. ` +
        `${paid > 0 ? `Paid ${usd(paid)}.` : "Nothing paid yet."} ` +
        `${subs.length ? `${plural(subs.length, "Subscription")}: ${subs.map((s) => `${usd(s.items.reduce((t, i) => t + i.amount * i.quantity, 0))}, ${s.id}, ${subStatus(s)}`).join("; ")}.` : "No subscription."} ` +
        `It counts for no one until an admin presses Yes, it's theirs on their Billing tab (or Not theirs).`,
    });
  }

  // 3. Counted by an automatic name match: a new customer, or a new client.
  const countedNow = new Set<string>(); // client|customer said for the first time in this pass
  for (const [clientId, b] of byClient) {
    const c = clientById.get(clientId);
    if (!c || c.internal) continue;
    const clientIsNew = c.createdAt != null && now - c.createdAt <= NEW_FOR_MS;
    for (const cu of b.customers) {
      if (cu.source !== "name match") continue;
      const created = customerById.get(cu.id)?.created ?? 0;
      if (!clientIsNew && now - created * 1000 > NEW_FOR_MS) continue;
      const ref = `stripe-counted:${clientId}:${cu.id}`;
      if (!said.has(ref)) countedNow.add(`${clientId}|${cu.id}`);
      const subs = b.subscriptions.filter((s) => s.customer === cu.id);
      const running = subs.filter((s) => !s.canceled);
      const collecting = running.filter((s) => !s.collectionPaused);
      // What it means for the client's status: a pause or churn from now on stops these, or one already made didn't.
      const status = (c.status ?? "").toLowerCase();
      const effect = status === "churned" || status === "paused"
        ? (collecting.length ? `${c.name} is ${status}, but ${plural(collecting.length, "this subscription is", "these subscriptions are")} still collecting. ` : "")
        : (running.length ? `Pausing or churning ${c.name} pauses ${plural(running.length, "it", "them")} too. ` : "");
      out.push({
        kind: "stripe_counted", severity: "info", clientId, ref,
        title: `Stripe customer counted for ${c.name}`,
        body: `${payer({ name: cu.name, email: cu.email })}, customer ${cu.id}, matched by name. ` +
          `${subs.length ? `${plural(subs.length, "Subscription")}: ${subs.map((s) => `${usd(s.amount)} ${s.every}, ${s.id}, ${s.canceled ? "cancelled" : s.collectionPaused ? "paused" : s.status === "past_due" ? "past due" : "collecting"}`).join("; ")}.` : "No subscription yet."} ` +
          `${effect}If it isn't theirs, an admin can press Not this client on their Billing tab.`,
      });
    }
  }

  // 4. A new subscription counted for a client.
  for (const [clientId, b] of byClient) {
    const c = clientById.get(clientId);
    if (!c || c.internal) continue;
    for (const s of b.subscriptions) {
      const raw = subById.get(s.id);
      if (!raw || now - raw.created * 1000 > RECENT_PAYMENT_MS) continue;
      // Said already: by the customer's own "counted" alert, in this pass or an earlier one that named it.
      if (countedNow.has(`${clientId}|${s.customer}`) || named.has(s.id)) continue;
      const byName = b.customers.find((cu) => cu.id === s.customer)?.source === "name match";
      out.push({
        kind: "stripe_new_subscription", severity: "info", clientId, ref: `stripe-newsub:${s.id}`,
        title: `New subscription: ${c.name}`,
        body: `${usd(s.amount)} ${s.every}, started ${day(raw.created * 1000)}. Subscription ${s.id}, customer ${s.customer}.` +
          (byName ? ` Counted for ${c.name} because the customer's name matches; if it isn't theirs, an admin can press Not this client on their Billing tab.` : ""),
      });
    }
  }

  // 5. Onboarded lately, nothing in Stripe counted or found for it, and payments no client has are waiting.
  const foundFor = new Set(suggestions.map((x) => x.clientId));
  // A customer one of whose subscriptions a client owns is that client's business, whatever was said about the customer.
  const subscribed = new Set([...byClient.values()].flatMap((b) => b.subscriptions.map((s) => s.customer)));
  const waiting = snapshot.customers
    // Our own addresses are the team's test payments, never a client's; one found for a client is that client's to confirm.
    .filter((cu) => !customerOwners.has(cu.id) && !suggestedFor.has(cu.id) && !subscribed.has(cu.id) && now - cu.created * 1000 <= NEW_FOR_MS && (!cu.email || !!matchEmailKey(cu.email)))
    .map((cu) => ({ ...cu, paid: paidBy(cu.id) }))
    .filter((cu) => cu.paid > 0);
  for (const c of clients) {
    if (c.internal || c.createdAt == null || !STILL_STARTING.has((c.status ?? "").toLowerCase())) continue;
    const age = now - c.createdAt;
    if (age < SETTLE_MS || age > ONBOARDED_RECENTLY_MS) continue;
    // Only a reading of Stripe made after the client settled can say nothing matches it.
    if ((snapshot.readAt ?? 0) < c.createdAt + SETTLE_MS) continue;
    const b = byClient.get(c.id);
    if ((b && (b.customers.length || b.subscriptions.length)) || foundFor.has(c.id) || paidWithoutCustomer.has(c.id)) continue;
    if (!waiting.length) continue;
    // Not one this client said Not this client to.
    const offered = waiting.filter((cu) => !excluded.has(`${c.id}|${cu.id}`));
    if (!offered.length) continue;
    const mine = (cu: { id: string; email: string | null }) => hintId(cu.email, cu.id) === c.id;
    const ranked = [...offered].sort((x, y) => Number(mine(y)) - Number(mine(x)) || y.created - x.created);
    const shown = ranked.slice(0, 3).map((cu) => `${payer(cu)}, ${usd(cu.paid)}, ${cu.id}${mine(cu) ? " (same email domain)" : ""}`);
    out.push({
      kind: "stripe_no_customer", severity: "warning", clientId: c.id, ref: `stripe-nocustomer:${c.id}`,
      title: `No Stripe payment found for ${c.name}`,
      body: `Onboarded ${day(c.createdAt)}. No Stripe customer has ${c.name}'s emails or name. ` +
        `Paid lately with no client: ${shown.join("; ")}${ranked.length > 3 ? `; and ${ranked.length - 3} more` : ""}. If one is theirs, an admin can link it on their Billing tab.`,
    });
  }
  return out;
}
