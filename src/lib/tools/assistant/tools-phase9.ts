import "server-only";

import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { isKnownNonClient } from "@/lib/clients/roster";
import { completeness } from "@/lib/clients/completeness";
import { effectiveSignup } from "@/lib/clients/signup";
import { stripeSummaries } from "@/lib/clients/stripe-summary";
import { savedViewsByClient } from "@/lib/clients/saved-views";
import { blockThreshold, blockingEnabled, openPortalBlocks } from "@/lib/clients/billing-watch";
import { osTable } from "@/lib/clients/os-db";
import { getAccountBilling } from "@/lib/clients/billing-account";

/*
 * Phase 9 (7 Oct): what the OS gained on 6 Oct — profile completeness, saved
 * views, the sign-up rule, failed-payment notifications and portal blocks.
 * Without these the assistant said the features did not exist. READ ONLY:
 * nothing here runs the billing watch or marks a notification read.
 */

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The clients as the Clients screen shows them: Stripe figures and saved views merged in. */
export async function clientsAsShown(): Promise<{ clients: MasterClient[]; unavailable: string[] }> {
  const { clients: raw } = await getMasterClientList();
  const all = raw.filter((c) => !isKnownNonClient(c.name));
  const unavailable: string[] = [];
  const linked = all.filter((c) => c.stripeCustomerId || c.stripeSubscriptionId);
  const [stripe, views] = await Promise.all([
    stripeSummaries(linked).catch(() => { unavailable.push("Stripe"); return null; }),
    savedViewsByClient().catch(() => { unavailable.push("the Database (saved views)"); return null; }),
  ]);
  return {
    clients: all.map((c) => ({
      ...c,
      stripe: stripe ? stripe.byId[c.id] ?? null : null,
      savedViews: views ? views.byClient[c.id] ?? [] : null,
    })),
    unavailable,
  };
}

/** One client's profile: completeness, what is missing and where it is fixed, saved views, leads, sign-up. */
export function profileOf(c: MasterClient) {
  const p = completeness(c);
  const signup = effectiveSignup(c);
  return {
    completeness: `${p.pct}%`,
    checksDone: `${p.done} of ${p.total}`,
    missing: p.missing.map((m) => ({ item: m.label, howToFix: m.how, where: `Clients → ${c.name} → ${m.tab === "record" ? "Record" : m.tab === "markets" ? "Markets" : m.tab === "introduce" ? "Introduce to" : "Campaigns"} tab` })),
    stillLoading: p.pending ? `${p.pending} check(s) could not be read (Stripe or the Database)` : undefined,
    savedViews: c.savedViews === null ? "unknown — the Database could not be read" : (c.savedViews ?? []).map((v) => ({ name: v.name, agents: v.agents, how: v.source })),
    leadsAssigned: c.assignedLeads,
    signUp: signup.date ? { date: signup.date, source: signup.source, afterOnboarding: signup.afterOnboarding } : null,
  };
}

export async function profileCompletenessTool(f: { client?: string; status?: string; missing?: string }) {
  const { clients, unavailable } = await clientsAsShown();
  let rows = clients;
  if (f.client) rows = rows.filter((c) => [c.name, ...c.aliases].some((n) => norm(n).includes(norm(f.client))));
  if (f.status) rows = rows.filter((c) => c.status === f.status!.toLowerCase());
  const out = rows.map((c) => ({ c, p: completeness(c), s: effectiveSignup(c) }));
  const wanted = f.missing ? norm(f.missing) : "";
  const filtered = wanted
    ? out.filter(({ p }) => p.missing.some((m) => norm(m.label).includes(wanted) || norm(m.key).includes(wanted)))
    : out;
  return {
    filters: f,
    total: filtered.length,
    averageCompleteness: filtered.length ? `${Math.round(filtered.reduce((t, x) => t + x.p.pct, 0) / filtered.length)}%` : null,
    clients: filtered
      .sort((a, b) => a.p.pct - b.p.pct || a.c.name.localeCompare(b.c.name))
      .slice(0, 60)
      .map(({ c, p, s }) => ({
        client: c.name, status: c.status, completeness: `${p.pct}%`, missing: p.missing.map((m) => m.label),
        savedViews: c.savedViews === null ? null : (c.savedViews ?? []).length, leadsAssigned: c.assignedLeads,
        signUpAfterOnboarding: s.afterOnboarding ? `signed up ${s.date}, onboarding ${c.onboardingDate?.slice(0, 10)}` : undefined,
      })),
    signUpAfterOnboarding: out.filter((x) => x.s.afterOnboarding).map((x) => ({ client: x.c.name, signUp: x.s.date, onboarding: x.c.onboardingDate?.slice(0, 10) })),
    note:
      "Profile completeness is the share of 22 checks done (plan, dates, people, website, Zillow, POC, timezone, billing schedule, target, markets/MLS/area, intro person and brokerage, Stripe subscription, saved view, leads assigned, portal) — the same score the Clients list and each record show, where each gap has a Fix button. " +
      "Saved views are the client's agent searches in the Database, matched by name or the view's Client filter, or linked on the record. Sign-up = the first $1 charge in Stripe; a sign-up later than onboarding is flagged (the same day is fine)." +
      (unavailable.length ? ` Not read this time: ${unavailable.join(", ")}.` : ""),
  };
}

export async function notificationsTool() {
  const { data, error } = await osTable("os_notifications")
    .select("kind, severity, title, body, created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  const blocks = await openPortalBlocks();
  const { data: names } = await osTable("os_clients").select("id, name");
  const nameOf = new Map(((names ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  // What the bell is about, read live from Stripe — so the answer is right even before 0030 stores notifications.
  const acct = await getAccountBilling().catch(() => null);
  const failedNow = acct
    ? [...acct.byClient.entries()].flatMap(([id, b]) => b.failedInvoices.map((i) => ({ client: nameOf.get(id) ?? id, invoice: i.number, unpaid: i.amountRemaining, attempts: i.attemptCount, nextTry: i.nextAttempt ? new Date(i.nextAttempt * 1000).toISOString().slice(0, 10) : null })))
    : null;
  return {
    ready: !error,
    bell: error ? "EMPTY — the bell starts storing notifications once database migration 0030 is run" : `${(data ?? []).length} recent notification(s)`,
    notifications: error ? [] : ((data ?? []) as Array<{ kind: string; severity: string; title: string; body: string | null; created_at: string }>).map((n) => ({ when: n.created_at, severity: n.severity, title: n.title, detail: n.body })),
    failedPaymentsInStripeNow: failedNow ?? "Stripe could not be read",
    portalBlocks: blocks.map((b) => ({ client: nameOf.get(b.clientId) ?? b.clientId, mode: b.mode === "blocked" ? "BLOCKED — the portal shows a 'paused, pay the invoice' page" : "dry run — would be blocked, nothing changed", since: b.since, reason: b.reason })),
    policy: {
      blockAfterAttempts: blockThreshold(),
      blockingSwitchedOn: blockingEnabled(),
      rule: `A failed payment notifies the OS (the bell, admins only) on every attempt. After Stripe's first attempt plus 3 recovery retries (${blockThreshold()} attempts) the client's portal is blocked — ${blockingEnabled() ? "blocking is ON" : "currently a DRY RUN: it is recorded who would be blocked, no portal changes"}. Paying the invoice lifts the block automatically.`,
    },
    note: (error ? "The bell stores nothing until database migration 0030 runs — but failedPaymentsInStripeNow is read live from Stripe and is the answer to 'which payments failed'." : "The OS notifications bell, plus the failed payments in Stripe right now. Read only — nothing is marked read.") +
      " An invoice with many attempts and an old date usually belongs to a paused or churned client and is still open in Stripe.",
  };
}
