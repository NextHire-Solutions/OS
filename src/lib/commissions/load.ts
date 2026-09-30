import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { dayNumber, dayToDate, scheduleFor } from "@/lib/tools/client-health/billing";
import type { BillingInterval } from "@/lib/tools/client-health/types";
import { listTeamMembers, type TeamMember } from "@/lib/identity/team-directory";
import { accountManagerPool, isManagedBy, splitManagers } from "@/lib/identity/team-match";
import { isSoldBy, type Salesperson } from "@/lib/identity/salesperson-match";
import { listSalespeople } from "@/lib/identity/salespeople";

import {
  DEFAULT_RATES, cancellationDay, commissionLines, easternDay, estimatedPayments, linesForRun, nextRun, previousRun,
  runOnOrAfter, sum, type Line, type Payment, type Rates, type StatusChange,
} from "./schedule";
import { stripeGross, stripePayments } from "./stripe-payments";

/*
 * COMMISSIONS — who earns what, on which payout run.
 *
 *   who     BOTH people on a client (the client, 30 Sep): its Salesperson and
 *           its Account Manager, each at their own rates — 70% of the first
 *           month, then their residual (15% or 25%). A salesperson is someone
 *           with the Salesperson role (os_salespeople); an account manager,
 *           someone with the Account manager role on Team access.
 *   what    paid Stripe invoices on the client's subscription; for a client
 *           with no Stripe link, an admin-entered gross ESTIMATED on its
 *           billing schedule (and labelled as an estimate)
 *   when    the next payout run (1st / 15th) after each payment
 *
 * SCOPE IS ENFORCED HERE, not in the browser: a person's view is built from
 * their own earnings only — as a salesperson, an account manager, or both —
 * and nothing about anyone else's payouts is in the response. Only admins
 * see everyone.
 */

export type EarnerRole = "salesperson" | "account_manager";

/** Someone who can earn: "sp:<salesperson id>" or "am:<email>". */
export interface Earner {
  key: string;
  role: EarnerRole;
  name: string;
  email: string | null;
  rates: Rates;
}

export interface Earning {
  key: string;
  role: EarnerRole;
  name: string;
  rates: Rates;
  due: number;
  lines: Line[];
  lifetime: number;
}

export interface CommissionRow {
  id: string;
  name: string;
  plan: string | null;
  status: MasterClient["status"];
  salesperson: string | null;
  accountManager: string | null;
  /** Gross per 28 days, and where it came from. */
  gross: number | null;
  grossSource: "stripe" | "manual" | null;
  /** A manual gross an admin set (shown in the editor even when Stripe wins). */
  manualGross: number | null;
  stripeLinked: boolean;
  statusLabel: string;
  /** What each person IN VIEW earns on this client. */
  earnings: Earning[];
  /** Their total on the selected run. */
  due: number;
  lastPayment: string | null;
}

export interface RepSummary {
  key: string;
  role: EarnerRole;
  name: string;
  email: string | null;
  rates: Rates;
  due: number;
  clients: number;
  month1: number;
  residual: number;
}

export interface CommissionsView {
  today: string;
  run: string;
  previousRun: string;
  nextRun: string;
  /** The run date is still ahead: its figures are what has been billed so far. */
  runOpen: boolean;
  viewer: { email: string; name: string; admin: boolean };
  /** "all" (admins), one earner key, or "mine" — everything the viewer earns. */
  scope: string;
  reps: RepSummary[];
  rows: CommissionRow[];
  /** Admin only: clients missing a salesperson or an account manager. */
  /** Current values ride along so the Assign form keeps what it doesn't change. */
  unassigned: { id: string; name: string; status: MasterClient["status"]; missing: EarnerRole[]; salesperson: string | null; accountManager: string | null; manualGross: number | null; stripeLinked: boolean }[];
  /** Admin only: who can be picked, by role. */
  team: string[];
  salespeople: string[];
  /** Admin only: everyone who can be viewed. */
  people: { key: string; name: string; role: EarnerRole }[];
  settingsAvailable: boolean;
  unavailable: string[];
}

export type Settings = { rates: Map<string, Rates>; gross: Map<string, number>; available: boolean };

async function readSettings(): Promise<Settings> {
  const [r, g] = await Promise.all([
    osTable("os_commission_reps").select("email, month_one_rate, residual_rate"),
    osTable("os_client_commission").select("client_id, monthly_gross"),
  ]);
  // Before migration 0019 the tables do not exist: defaults, nothing stored.
  if (r.error || g.error) return { rates: new Map(), gross: new Map(), available: false };
  const rates = new Map<string, Rates>();
  for (const row of (r.data ?? []) as unknown as { email: string; month_one_rate: number; residual_rate: number }[]) {
    rates.set(row.email.toLowerCase(), { monthOne: Number(row.month_one_rate), residual: Number(row.residual_rate) });
  }
  const gross = new Map<string, number>();
  for (const row of (g.data ?? []) as unknown as { client_id: string; monthly_gross: number }[]) gross.set(row.client_id, Number(row.monthly_gross));
  return { rates, gross, available: true };
}

async function readHistory(): Promise<Map<string, StatusChange[]>> {
  const { data, error } = await osTable("os_client_status_history")
    .select("os_client_id, from_status, to_status, changed_at").order("changed_at", { ascending: true }).limit(10000);
  if (error) throw new Error(error.message);
  const out = new Map<string, StatusChange[]>();
  for (const r of (data ?? []) as unknown as { os_client_id: string; from_status: string | null; to_status: string; changed_at: string }[]) {
    const list = out.get(r.os_client_id) ?? [];
    list.push({ from: r.from_status, to: r.to_status, at: r.changed_at });
    out.set(r.os_client_id, list);
  }
  return out;
}

/** Billing dates on the client's schedule from its first billing up to `until`. */
function scheduleDates(c: MasterClient, until: string): { dates: string[]; cycleDays: number | null } {
  const interval = (c.billingInterval ?? "biweekly") as BillingInterval;
  const s = scheduleFor({
    billing_anchor_date: c.billingAnchorDate, start_date: c.startDate, billing_interval: interval,
    billing_interval_days: c.billingIntervalDays, monthly_target: 0, intro_dates: [],
  });
  const startISO = c.startDate ?? c.billingAnchorDate;
  if (!s || !startISO) return { dates: [], cycleDays: null };
  const cycleDays = interval === "biweekly" ? 14 : interval === "28-days" ? 28 : interval === "custom" ? c.billingIntervalDays : null;
  const dates: string[] = [];
  for (let k = s.cycleIndexOf(dayNumber(startISO)) + 1; dates.length < 400; k++) {
    const d = dayToDate(s.billingDay(k)).toISOString().slice(0, 10);
    if (d > until) break;
    dates.push(d);
  }
  return { dates, cycleDays };
}

function label(c: MasterClient, changes: StatusChange[], lines: Line[], runLines: Line[], hasSource: boolean): string {
  if (c.status === "churned") {
    const d = cancellationDay(changes, c.status);
    return d ? `Cancelled ${new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : "Cancelled";
  }
  if (c.status === "paused") return "Paused";
  if (!hasSource) return "No billing data";
  if (runLines.some((l) => l.kind === "month1")) return "Month 1";
  if (!lines.length) return c.status === "onboarding" ? "Onboarding" : "Not billed yet";
  return lines[lines.length - 1].kind === "month1" ? "Month 1" : "Active · residual";
}

export interface BuildInputs {
  clients: MasterClient[];
  team: TeamMember[];
  /** The Salesperson role's records (os_salespeople), with their rates. */
  salespeople: Salesperson[];
  settings: Settings;
  history: Map<string, StatusChange[]>;
  /** Per client id: its Stripe payments and gross, or null when Stripe could not be read. */
  stripe: Map<string, { payments: Payment[]; gross: number | null } | null>;
  viewerEmail: string;
  admin: boolean;
  as?: string | null;
  run?: string | null;
  today: string;
  unavailable: string[];
}

/*
 * A client with more than one Account Manager written on it (older data,
 * "Amy, Eddy") is earned once, by the first one named — never paid twice.
 */
const firstManager = (c: { accountManager: string | null }) => splitManagers(c.accountManager)[0] ?? null;

/** Everyone who can earn, and who earns on each client. */
export function earnersFor(inp: Pick<BuildInputs, "clients" | "team" | "salespeople" | "settings">) {
  const earners = new Map<string, Earner>();
  for (const sp of inp.salespeople) {
    earners.set(`sp:${sp.id}`, { key: `sp:${sp.id}`, role: "salesperson", name: sp.name, email: sp.email, rates: sp.rates });
  }
  // Account managers: people with the role, and anyone a client still names —
  // never every team member (someone with no role saw a $0 card, audit 30 Sep).
  const pool = new Set(accountManagerPool(inp.team).map((m) => m.email));
  const named = new Set(inp.clients.map(firstManager).filter((n): n is string => !!n));
  for (const m of inp.team) {
    if (!pool.has(m.email) && ![...named].some((n) => isManagedBy(n, m))) continue;
    earners.set(`am:${m.email}`, { key: `am:${m.email}`, role: "account_manager", name: m.name, email: m.email, rates: inp.settings.rates.get(m.email) ?? DEFAULT_RATES });
  }
  const onClient = (c: MasterClient): Earner[] => {
    const out: Earner[] = [];
    const sp = c.salesperson ? inp.salespeople.find((p) => isSoldBy(c.salesperson, p)) : undefined;
    if (sp) out.push(earners.get(`sp:${sp.id}`)!);
    const amName = firstManager(c);
    const am = amName ? inp.team.find((m) => isManagedBy(amName, m)) : undefined;
    if (am && earners.has(`am:${am.email}`)) out.push(earners.get(`am:${am.email}`)!);
    return out;
  };
  return { earners, onClient };
}

/** Which earnings a viewer may see — the one place scope is decided. */
export function scopeFor(inp: Pick<BuildInputs, "clients" | "team" | "salespeople" | "settings" | "viewerEmail" | "admin" | "as">) {
  const viewerEmail = inp.viewerEmail.toLowerCase();
  const { earners, onClient } = earnersFor(inp);
  // The viewer's own earner keys: as an account manager, as a salesperson, or both.
  const mine = [...earners.values()].filter((e) => e.email === viewerEmail).map((e) => e.key);
  let keys: Set<string>;
  let scope: string;
  if (inp.admin && inp.as && inp.as !== "all" && earners.has(inp.as)) { keys = new Set([inp.as]); scope = inp.as; }
  else if (inp.admin) { keys = new Set(earners.keys()); scope = "all"; }
  else { keys = new Set(mine); scope = "mine"; }
  const inScope = inp.clients.filter((c) => onClient(c).some((e) => keys.has(e.key)));
  const member = inp.team.find((m) => m.email === viewerEmail);
  const viewerName = member?.name ?? inp.salespeople.find((p) => p.email === viewerEmail)?.name ?? viewerEmail.split("@")[0];
  return { earners, onClient, keys, scope, inScope, mine, viewerName };
}

/** The whole view from its inputs — pure, so scope and sums are tested without a database. */
export function buildCommissionsView(inp: BuildInputs): CommissionsView {
  const { today, settings, history } = inp;
  const run = inp.run && /^\d{4}-\d{2}-(01|15)$/.test(inp.run) ? inp.run : runOnOrAfter(today);
  const { earners, onClient, keys, scope, inScope, viewerName } = scopeFor(inp);
  // Payments are counted up to today only — a run still ahead shows what has been billed so far.
  const horizon = run < today ? run : today;

  const rows: CommissionRow[] = inScope.map((c) => {
    /*
     * A churn date entered on the record (0023) is when accrual stops, even
     * when the status history (which starts 13 Sep) has no such change.
     */
    const recorded = history.get(c.id) ?? [];
    const changes: StatusChange[] = c.status === "churned" && c.churnDate
      ? [...recorded, { from: "active", to: "churned", at: `${c.churnDate.slice(0, 10)}T12:00:00Z` }]
      : recorded;
    const manual = settings.gross.get(c.id) ?? null;
    const linked = Boolean(c.stripeSubscriptionId);
    const st = inp.stripe.get(c.id);
    let payments: Payment[] = [];
    let gross: number | null = null;
    let grossSource: CommissionRow["grossSource"] = null;
    if (linked && st) {
      payments = st.payments.filter((p) => p.date <= horizon);
      gross = st.gross;
      grossSource = gross !== null ? "stripe" : null;
    } else if (!linked && manual !== null) {
      const { dates, cycleDays } = scheduleDates(c, horizon);
      payments = estimatedPayments(dates, manual, cycleDays);
      gross = manual;
      grossSource = "manual";
    }
    const earnings: Earning[] = onClient(c).filter((e) => keys.has(e.key)).map((e) => {
      const lines = commissionLines(payments, changes, c.status, e.rates);
      const runLines = linesForRun(lines, run);
      return { key: e.key, role: e.role, name: e.name, rates: e.rates, due: sum(runLines), lines: runLines, lifetime: sum(lines) };
    });
    // The status label reads the same whoever earns: from the first earner's lines.
    const all = commissionLines(payments, changes, c.status, earnings[0]?.rates ?? DEFAULT_RATES);
    return {
      id: c.id, name: c.name, plan: c.plan, status: c.status,
      salesperson: c.salesperson, accountManager: firstManager(c),
      gross, grossSource, manualGross: manual, stripeLinked: linked,
      statusLabel: label(c, changes, all, linesForRun(all, run), payments.length > 0 || gross !== null),
      earnings,
      due: sum(earnings.flatMap((e) => e.lines)),
      lastPayment: payments.length ? payments[payments.length - 1].date : null,
    };
  }).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));

  // Cards: each earner in view who holds a client here.
  const reps: RepSummary[] = [...keys].map((k) => earners.get(k)!).flatMap((e) => {
    const mine = rows.flatMap((r) => r.earnings.filter((x) => x.key === e.key));
    if (!mine.length && scope === "all") return [];
    return [{
      key: e.key, role: e.role, name: e.name, email: e.email, rates: e.rates,
      due: sum(mine.flatMap((x) => x.lines)),
      clients: mine.length,
      month1: mine.filter((x) => x.lines.some((l) => l.kind === "month1")).length,
      residual: mine.filter((x) => x.lines.some((l) => l.kind === "residual")).length,
    }];
  }).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));

  const holding = new Set(inp.clients.flatMap((c) => onClient(c).map((e) => e.key)));
  return {
    today, run, previousRun: previousRun(run), nextRun: nextRun(run), runOpen: run > today,
    viewer: { email: inp.viewerEmail.toLowerCase(), name: viewerName, admin: inp.admin },
    scope, reps, rows,
    unassigned: inp.admin
      ? inp.clients.flatMap((c) => {
          const on = onClient(c).map((e) => e.role);
          const missing = (["salesperson", "account_manager"] as EarnerRole[]).filter((r) => !on.includes(r));
          return missing.length
            ? [{ id: c.id, name: c.name, status: c.status, missing, salesperson: c.salesperson, accountManager: firstManager(c), manualGross: settings.gross.get(c.id) ?? null, stripeLinked: Boolean(c.stripeSubscriptionId) }]
            : [];
        })
      : [],
    team: inp.admin ? accountManagerPool(inp.team).map((m) => m.name).sort() : [],
    salespeople: inp.admin ? inp.salespeople.filter((p) => p.active).map((p) => p.name).sort() : [],
    people: inp.admin
      ? [...earners.values()]
          .filter((e) => holding.has(e.key) || (e.role === "salesperson" ? inp.salespeople.find((p) => `sp:${p.id}` === e.key)?.active : accountManagerPool(inp.team).some((m) => `am:${m.email}` === e.key)))
          .map((e) => ({ key: e.key, name: e.name, role: e.role }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.role.localeCompare(b.role))
      : [],
    settingsAvailable: settings.available,
    unavailable: inp.unavailable,
  };
}

export async function loadCommissions(opts: { viewerEmail: string; admin: boolean; as?: string | null; run?: string | null }): Promise<CommissionsView> {
  const today = easternDay(new Date());
  const unavailable: string[] = [];
  const [list, team, sp, settings, history] = await Promise.all([
    getMasterClientList(),
    listTeamMembers(),
    listSalespeople().catch(() => { unavailable.push("Salespeople"); return { available: false, people: [] as Salesperson[] }; }),
    readSettings().catch(() => ({ rates: new Map(), gross: new Map(), available: false } as Settings)),
    readHistory().catch(() => { unavailable.push("Status history"); return new Map<string, StatusChange[]>(); }),
  ]);
  const base = { clients: list.clients, team, salespeople: sp.people, settings };

  // Stripe is read only for the clients this viewer may see.
  const { inScope } = scopeFor({ ...base, viewerEmail: opts.viewerEmail, admin: opts.admin, as: opts.as });
  const linked = inScope.filter((c) => c.stripeSubscriptionId);
  const results = await Promise.all(linked.map(async (c) => {
    try {
      const [payments, g] = await Promise.all([stripePayments(c.stripeSubscriptionId!), stripeGross(c.stripeSubscriptionId!)]);
      return [c.id, { payments, gross: g?.per28 ?? null }] as const;
    } catch {
      return [c.id, null] as const;
    }
  }));
  const stripe = new Map(results);
  if (results.some(([, v]) => v === null)) unavailable.push("Stripe (some clients)");

  return buildCommissionsView({
    ...base, history, stripe,
    viewerEmail: opts.viewerEmail, admin: opts.admin, as: opts.as, run: opts.run,
    today, unavailable: [...unavailable, ...list.unavailable],
  });
}
