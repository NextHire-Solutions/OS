import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { getMasterClientList, type MasterClient } from "@/lib/clients/master-list";
import { dayNumber, dayToDate, scheduleFor } from "@/lib/tools/client-health/billing";
import type { BillingInterval } from "@/lib/tools/client-health/types";
import { listTeamMembers, type TeamMember } from "@/lib/identity/team-directory";
import { isManagedBy, splitManagers } from "@/lib/identity/team-match";

/*
 * A client can have several Account Managers (30 Sep). Until the business
 * says how a commission is split between them, it is earned once, by the
 * FIRST one named — never paid twice. The page says so.
 */
const earnerOf = (c: { accountManager: string | null }) => splitManagers(c.accountManager)[0] ?? null;
const earnsOn = (c: { accountManager: string | null }, m: Pick<TeamMember, "name" | "email">) => isManagedBy(earnerOf(c), m);

import {
  DEFAULT_RATES, cancellationDay, commissionLines, easternDay, estimatedPayments, linesForRun, nextRun, previousRun,
  runOnOrAfter, sum, type Line, type Payment, type Rates, type StatusChange,
} from "./schedule";
import { stripeGross, stripePayments } from "./stripe-payments";

/*
 * COMMISSIONS — who earns what, on which payout run.
 *
 *   who     the client's Account Manager (a Team access member)
 *   what    paid Stripe invoices on the client's subscription; for a client
 *           with no Stripe link, an admin-entered gross ESTIMATED on its
 *           billing schedule (and labelled as an estimate)
 *   when    the next payout run (1st / 15th) after each payment
 *
 * SCOPE IS ENFORCED HERE, not in the browser: an account manager's view is
 * built from their own clients only, and nothing about another person's
 * clients or payouts is in the response. Only admins see everyone.
 */

export interface CommissionRow {
  id: string;
  name: string;
  plan: string | null;
  status: MasterClient["status"];
  accountManager: string | null;
  /** Gross per 28 days, and where it came from. */
  gross: number | null;
  grossSource: "stripe" | "manual" | null;
  /** A manual gross an admin set (shown in the editor even when Stripe wins). */
  manualGross: number | null;
  stripeLinked: boolean;
  statusLabel: string;
  /** Commission on the selected run, and the payments behind it. */
  due: number;
  lines: Line[];
  /** Every commission this client has earned the rep, all runs. */
  lifetime: number;
  lastPayment: string | null;
}

export interface RepSummary {
  email: string;
  name: string;
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
  /** "all" (admins) or the email of the account manager being shown. */
  scope: string;
  reps: RepSummary[];
  rows: CommissionRow[];
  /** Admin only: clients with no account manager, and the team to pick from. */
  unassigned: { id: string; name: string; status: MasterClient["status"] }[];
  team: string[];
  /** Admin only: everyone who can be viewed — active members, and anyone still holding clients. */
  people: { email: string; name: string }[];
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

/** Which clients a viewer may see — the one place scope is decided. */
export function scopeFor(inp: Pick<BuildInputs, "clients" | "team" | "viewerEmail" | "admin" | "as">) {
  const viewerEmail = inp.viewerEmail.toLowerCase();
  const viewer = inp.team.find((m) => m.email === viewerEmail) ?? { email: viewerEmail, name: viewerEmail.split("@")[0], active: true, admin: inp.admin };
  let scopeMember: TeamMember | null = inp.admin ? null : viewer;
  if (inp.admin && inp.as && inp.as !== "all") scopeMember = inp.team.find((m) => m.email === inp.as!.toLowerCase()) ?? null;
  const assigned = inp.clients.filter((c) => c.accountManager);
  const inScope = scopeMember ? assigned.filter((c) => earnsOn(c, scopeMember!)) : inp.admin ? assigned : [];
  return { viewer, scopeMember, assigned, inScope };
}

/** The whole view from its inputs — pure, so scope and sums are tested without a database. */
export function buildCommissionsView(inp: BuildInputs): CommissionsView {
  const { today, settings, history, team } = inp;
  const run = inp.run && /^\d{4}-\d{2}-(01|15)$/.test(inp.run) ? inp.run : runOnOrAfter(today);
  const { viewer, scopeMember, assigned, inScope } = scopeFor(inp);
  const scope = scopeMember ? scopeMember.email : "all";
  const repOf = (c: MasterClient) => team.find((m) => earnsOn(c, m)) ?? null;
  const ratesFor = (m: TeamMember | null) => (m && settings.rates.get(m.email)) || DEFAULT_RATES;
  // Payments are counted up to today only — a run still ahead shows what has been billed so far.
  const horizon = run < today ? run : today;

  const rows: CommissionRow[] = inScope.map((c) => {
    const rates = ratesFor(repOf(c));
    const changes = history.get(c.id) ?? [];
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
    const lines = commissionLines(payments, changes, c.status, rates);
    const runLines = linesForRun(lines, run);
    return {
      id: c.id, name: c.name, plan: c.plan, status: c.status, accountManager: c.accountManager,
      gross, grossSource, manualGross: manual, stripeLinked: linked,
      statusLabel: label(c, changes, lines, runLines, payments.length > 0 || gross !== null),
      due: sum(runLines), lines: runLines,
      lifetime: sum(lines),
      lastPayment: payments.length ? payments[payments.length - 1].date : null,
    };
  }).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));

  // Cards: the person in view, or — for "all" — everyone who actually holds clients.
  const people = scopeMember ? [scopeMember] : inp.admin ? team.filter((m) => assigned.some((c) => earnsOn(c, m))) : [];
  const reps: RepSummary[] = people.map((m) => {
    const mine = rows.filter((r) => earnsOn(r, m));
    return {
      email: m.email, name: m.name, rates: ratesFor(m),
      due: sum(mine.flatMap((r) => r.lines)),
      clients: mine.length,
      month1: mine.filter((r) => r.lines.some((l) => l.kind === "month1")).length,
      residual: mine.filter((r) => r.lines.some((l) => l.kind === "residual")).length,
    };
  }).sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));

  return {
    today, run, previousRun: previousRun(run), nextRun: nextRun(run), runOpen: run > today,
    viewer: { email: viewer.email, name: viewer.name, admin: inp.admin },
    scope, reps, rows,
    unassigned: inp.admin ? inp.clients.filter((c) => !c.accountManager).map((c) => ({ id: c.id, name: c.name, status: c.status })) : [],
    team: inp.admin ? team.filter((m) => m.active).map((m) => m.name).sort() : [],
    people: inp.admin
      ? team.filter((m) => m.active || assigned.some((c) => earnsOn(c, m)))
          .map((m) => ({ email: m.email, name: m.name })).sort((a, b) => a.name.localeCompare(b.name))
      : [],
    settingsAvailable: settings.available,
    unavailable: inp.unavailable,
  };
}

export async function loadCommissions(opts: { viewerEmail: string; admin: boolean; as?: string | null; run?: string | null }): Promise<CommissionsView> {
  const today = easternDay(new Date());
  const unavailable: string[] = [];
  const [list, team, settings, history] = await Promise.all([
    getMasterClientList(),
    listTeamMembers(),
    readSettings().catch(() => ({ rates: new Map(), gross: new Map(), available: false } as Settings)),
    readHistory().catch(() => { unavailable.push("Status history"); return new Map<string, StatusChange[]>(); }),
  ]);

  // Stripe is read only for the clients this viewer may see.
  const { inScope } = scopeFor({ clients: list.clients, team, viewerEmail: opts.viewerEmail, admin: opts.admin, as: opts.as });
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
    clients: list.clients, team, settings, history, stripe,
    viewerEmail: opts.viewerEmail, admin: opts.admin, as: opts.as, run: opts.run,
    today, unavailable: [...unavailable, ...list.unavailable],
  });
}
