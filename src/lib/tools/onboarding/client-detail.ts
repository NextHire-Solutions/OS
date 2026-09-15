import "server-only";

import { getOnboardingDb } from "./db";
import { getClientFields, getKnownFieldLabels } from "./client-fields";
import { mlsCodes, type ClientField } from "./client-field-types";
import { getPeople } from "./people";
import { getStages } from "./stages";
import { getStepLabels } from "./settings";
import { progressOf, stepStates, type Progress, type StepState } from "./step-state";
import { stripeMode, type StripeMode } from "./stripe-mode";
import type { Person } from "./people-types";
import type { Stage } from "./stage-types";

/**
 * One client, everything the detail screen shows — in a single read.
 *
 * Ported from the orchestrator's `app/clients/[id]/page.tsx`, which made eleven
 * separate awaits inside the page component. Here they are one function
 * returning one JSON payload, because the workspace's screens fetch rather than
 * render on the server, and eleven round trips over HTTP is a different cost
 * from eleven over a pooled Postgres connection.
 *
 * Everything below is a READ. The writes live in `client-writes.ts` and
 * `client-fields.ts`; the step actions live in `step-run.ts` / `step-actions.ts`.
 *
 * The tool's page begins with `await syncBisonImports()` — the DB-app handshake
 * (a read of `bison_campaigns`, no hub call) that picks up "leads imported"
 * flips on view. The client route does the same before calling this, so the
 * flags are as fresh here as there; the 10-minute scheduler maintains them
 * between views.
 */

/** The columns of `orch_clients` the screen reads. Everything else is untouched. */
export interface ClientRow {
  id: string;
  status: string | null;
  client_name: string | null;
  brand: string | null;
  office_name: string | null;
  primary_contact: { name?: string; email?: string; phone?: string; role?: string } | null;
  mls: string | null;
  location: string | null;
  timezone: string | null;
  onboarding_date: string | null;
  stage_id: string | null;
  filters: Record<string, number> | null;
  sender_name: string | null;
  tac_name: string | null;
  salesperson_id: string | null;
  account_manager_id: string | null;
  copy_status: string | null;
  created_at: string | null;
  updated_at: string | null;
  plan: string | null;
  weekly_target: number | null;
  portal_url: string | null;
  bison_campaign_id: string | null;
  bison_campaign_status: string | null;
  leads_inreview: boolean | null;
  bison_leads_exported: boolean | null;
  stripe_paid: boolean | null;
  stripe_paid_at: string | null;
  stripe_amount: number | null;
  stripe_payment_url: string | null;
  photo_url: string | null;
  health_status: string | null;
  salespeople: { id: string; name: string; photo_url: string | null } | null;
}

export interface TeamMember {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  isDnc: boolean;
  source: string | null;
}

export interface Delivery {
  id: string;
  target: string;
  action: string;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface Reply {
  id: string;
  fromEmail: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
}

export interface ClientProfile {
  id: string;
  name: string;
  brand: string | null;
  officeName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactRole: string | null;
  mls: string[];
  location: string | null;
  timezone: string | null;
  /** Pre-formatted on the server — see `onboardingCall` below. */
  onboardingCall: string | null;
  onboardingDate: string | null;
  senderName: string | null;
  salesVolumeMin: number | null;
  salesVolumeMax: number | null;
  closedMin: number | null;
  closedMax: number | null;
  plan: string | null;
  weeklyTarget: number | null;
  stageId: string | null;
  photoUrl: string | null;
  status: string | null;
  copyStatus: string | null;
  healthStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tacName: string | null;
  salespersonName: string | null;
  salespersonPhoto: string | null;
  accountManagerId: string | null;
  /** Present so the Agents tab can link to the client's own DNC page. */
  portalUrl: string | null;
  campaignId: string | null;
  campaignStatus: string | null;
  leadsInReview: boolean;
  leadsExported: boolean;
  paid: boolean;
  paidAt: string | null;
  amountCents: number | null;
  paymentUrl: string | null;
}

export interface ClientDetail {
  client: ClientProfile;
  stages: Stage[];
  /** Both roles, so the pickers can offer each and name the current holder. */
  salespeople: Person[];
  accountManagers: Person[];
  /** The one assigned, even when hidden from the picker. */
  accountManager: Person | null;
  fields: ClientField[];
  knownFieldLabels: string[];
  /** The client's own people we work with — form filler + introduction contacts. */
  team: TeamMember[];
  /** Their roster from the database — never contacted. */
  roster: TeamMember[];
  /** Do-not-contact entries from the intake form. */
  dnc: TeamMember[];
  leadCount: number;
  replies: Reply[];
  deliveries: Delivery[];
  steps: Record<string, StepState>;
  stepLabels: Record<string, string>;
  progress: Progress;
  /** Test or live — the payment box warns before a real charge. */
  stripeMode: StripeMode;
  /** The server's clock at load, so nothing on the screen reads the browser's. */
  now: string;
  error: string | null;
}

const COLS =
  "id, status, client_name, brand, office_name, primary_contact, mls, location, timezone, " +
  "onboarding_date, stage_id, filters, sender_name, tac_name, salesperson_id, account_manager_id, " +
  "copy_status, created_at, updated_at, plan, weekly_target, portal_url, bison_campaign_id, " +
  "bison_campaign_status, leads_inreview, bison_leads_exported, stripe_paid, stripe_paid_at, " +
  "stripe_amount, stripe_payment_url, photo_url, health_status, " +
  "salespeople:orch_salespeople!orch_clients_salesperson_id_fkey(id, name, photo_url)";

/** The raw row, for the writers that need to check the client exists first. */
export async function getClientRow(id: string): Promise<ClientRow | null> {
  const { data, error } = await getOnboardingDb()
    .from("orch_clients")
    .select(COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as ClientRow | null;
}

/*
 * The onboarding call, formatted once on the server.
 *
 * This is the one date on the screen that is NOT rendered with
 * `lib/workspace/dates.ts`, and the reason is that it has a timezone of its own:
 * the client told us theirs on the intake form, the tool shows the call in it,
 * and the whole point of the line is "when is this, for them". The workspace
 * helpers all pin Eastern.
 *
 * The rule those helpers exist to enforce is still kept, and kept the stronger
 * way: locale AND timeZone are both explicit, and the formatting happens in a
 * `server-only` module, so the string is computed once and shipped as a string.
 * The browser never re-derives it, so there is nothing for hydration to
 * disagree about.
 */
const TZ_MAP: Record<string, string> = {
  EST: "America/New_York",
  EDT: "America/New_York",
  ET: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  CT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  MT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  PT: "America/Los_Angeles",
};

export function formatOnboardingCall(iso?: string | null, tz?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const label = (tz ?? "EST").toUpperCase();
  const zone = TZ_MAP[label] ?? "America/New_York";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
  return `${date} at ${time} ${label}`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function toProfile(c: ClientRow): ClientProfile {
  const pc = c.primary_contact ?? {};
  const f = (c.filters ?? {}) as Record<string, number | undefined>;
  return {
    id: c.id,
    name: c.client_name ?? "(unnamed client)",
    brand: c.brand,
    officeName: c.office_name,
    contactName: pc.name ?? null,
    contactEmail: pc.email ?? null,
    contactPhone: pc.phone ?? null,
    contactRole: pc.role ?? null,
    mls: mlsCodes(c.mls),
    location: c.location,
    timezone: c.timezone,
    onboardingCall: formatOnboardingCall(c.onboarding_date, c.timezone),
    onboardingDate: c.onboarding_date,
    senderName: c.sender_name,
    salesVolumeMin: num(f.sales_volume_min),
    salesVolumeMax: num(f.sales_volume_max),
    closedMin: num(f.closed_transactions_min),
    closedMax: num(f.closed_transactions_max),
    plan: c.plan,
    weeklyTarget: c.weekly_target,
    stageId: c.stage_id,
    photoUrl: c.photo_url,
    status: c.status,
    copyStatus: c.copy_status,
    healthStatus: c.health_status,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    tacName: c.tac_name,
    salespersonName: c.salespeople?.name ?? null,
    salespersonPhoto: c.salespeople?.photo_url ?? null,
    accountManagerId: c.account_manager_id,
    portalUrl: c.portal_url,
    campaignId: c.bison_campaign_id,
    campaignStatus: c.bison_campaign_status,
    leadsInReview: !!c.leads_inreview,
    leadsExported: !!c.bison_leads_exported,
    paid: !!c.stripe_paid,
    paidAt: c.stripe_paid_at,
    amountCents: c.stripe_amount,
    paymentUrl: c.stripe_payment_url,
  };
}

/** Not found is `null`, so the route can answer 404 rather than an empty screen. */
export async function getClientDetail(id: string): Promise<ClientDetail | null> {
  const client = await getClientRow(id);
  if (!client) return null;

  const db = getOnboardingDb();
  try {
    const [teamRes, deliveriesRes, leadsRes, repliesRes, stages, people, fields, knownFieldLabels, stepLabels, steps] =
      await Promise.all([
        db.from("orch_client_team").select("id, name, email, phone, role, is_dnc, source").eq("client_id", id).order("name"),
        db
          .from("orch_connector_deliveries")
          .select("id, target, action, status, error, created_at")
          .eq("client_id", id)
          .order("created_at", { ascending: false })
          .limit(20),
        db.from("orch_client_leads").select("id", { count: "exact", head: true }).eq("client_id", id),
        db
          .from("orch_email_replies")
          .select("id, from_email, subject, snippet, received_at")
          .eq("client_id", id)
          .order("received_at", { ascending: false })
          .limit(20),
        getStages(),
        getPeople(),
        getClientFields(id),
        getKnownFieldLabels(),
        getStepLabels(),
        stepStates(id, client),
      ]);

    const rows = ((teamRes.data ?? []) as Record<string, unknown>[]).map(
      (t): TeamMember => ({
        id: t.id as string,
        name: (t.name as string | null) ?? null,
        email: (t.email as string | null) ?? null,
        phone: (t.phone as string | null) ?? null,
        role: (t.role as string | null) ?? null,
        isDnc: !!t.is_dnc,
        source: (t.source as string | null) ?? null,
      }),
    );

    /*
     * Three groups out of one table, exactly as the tool splits them:
     *
     *   team    the client's staff we work with (from the Typeform)
     *   roster  their own agents, matched from the database — never contacted
     *   dnc     offices and agents the client asked us to avoid
     *
     * `source` is what separates the first two, and `is_dnc` the first from the
     * third. Getting this split wrong would put a do-not-contact name into the
     * list of people we email, so it is duplicated nowhere else.
     */
    const team = rows.filter((t) => t.source === "typeform" && !t.isDnc);
    const roster = rows.filter((t) => t.source !== "typeform");
    const dnc = rows.filter((t) => t.source === "typeform" && t.isDnc);

    const allManagers = people.filter((p) => p.role === "account_manager");

    return {
      client: toProfile(client),
      stages,
      salespeople: people.filter((p) => p.role !== "account_manager" && p.active),
      // Hidden managers stay out of the picker but the current holder is kept
      // selectable below, so removing someone never blanks a client.
      accountManagers: allManagers.filter((p) => p.active),
      accountManager: allManagers.find((p) => p.id === client.account_manager_id) ?? null,
      fields,
      knownFieldLabels,
      team,
      roster,
      dnc,
      leadCount: leadsRes.count ?? 0,
      replies: ((repliesRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        fromEmail: (r.from_email as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        snippet: (r.snippet as string | null) ?? null,
        receivedAt: (r.received_at as string | null) ?? null,
      })),
      deliveries: ((deliveriesRes.data ?? []) as Record<string, unknown>[]).map((d) => ({
        id: d.id as string,
        target: d.target as string,
        action: d.action as string,
        status: d.status as string,
        error: (d.error as string | null) ?? null,
        createdAt: d.created_at as string,
      })),
      steps,
      stepLabels,
      progress: progressOf(steps),
      stripeMode: stripeMode(),
      now: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    // A failure costs this screen, never the workspace.
    return {
      client: toProfile(client),
      stages: [],
      salespeople: [],
      accountManagers: [],
      accountManager: null,
      fields: [],
      knownFieldLabels: [],
      team: [],
      roster: [],
      dnc: [],
      leadCount: 0,
      replies: [],
      deliveries: [],
      steps: {},
      stepLabels: {},
      progress: { done: 0, total: 0, pct: 0 },
      stripeMode: stripeMode(),
      now: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Onboarding is unreachable",
    };
  }
}
