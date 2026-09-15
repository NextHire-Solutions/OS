import { firstName } from "./text";
import { render } from "./template-types";
import type { IntakePerson } from "./typeform";

/*
 * What each connector SENDS, built without sending it. Ported from the tool's
 * `lib/connectors/apps.ts` and `lib/connectors/bison.ts`.
 *
 * Pure for the same reason `lib/clients/onboard-plan.ts` is: the Client Portal
 * push mints a live, login-free portal URL and the Bison build creates a
 * campaign, so "click it and see" is not a way to check the request is right.
 */

/** The fields of a client these builders read. A subset of the orch_clients row. */
export interface PayloadClient {
  id: string;
  client_name: string | null;
  mls?: string | null;
  location?: string | null;
  timezone?: string | null;
  plan?: string | null;
  weekly_target?: number | null;
  created_at?: string | null;
  primary_contact?: { name?: string; email?: string; role?: string } | null;
  salespeople?: { name: string } | null;
}

/* ------------------------------ Client Portal ---------------------------- */

/** Bison-style campaign alias: "ClientName + Sender + MLS/Location". */
export function buildAlias(c: PayloadClient): string {
  const parts = [c.client_name, c.salespeople?.name, c.mls || c.location].filter(Boolean);
  return parts.join(" + ");
}

/**
 * Intro macro = the person candidates actually meet. When the client isn't
 * taking introductions themselves, the form never asks their own role — use the
 * intro contact they named (with the title they gave) instead; the portal
 * rejects an empty role.
 */
export function introPerson(
  pc: { name?: string; role?: string },
  intake: IntakePerson[],
): { name: string; role: string } {
  const intro = intake.find((p) => !p.is_dnc && p.role) ?? null;
  const name = pc.role ? pc.name : (intro?.name ?? pc.name);
  const role = pc.role || intro?.role || "Team Leader";
  return { name: name ?? "", role };
}

export function portalOnboardBody(c: PayloadClient, intake: IntakePerson[]) {
  const pc = (c.primary_contact ?? {}) as { name?: string; role?: string };
  const person = introPerson(pc, intake);
  return {
    name: c.client_name,
    aliases: [buildAlias(c)].filter(Boolean),
    intro_macro: {
      brokerage: c.client_name,
      client_full_name: person.name,
      client_first_name: firstName(person.name),
      client_role: person.role,
    },
  };
}

/** The portal rejects empty strings ("expected string to have >=1 characters") — omit blanks. */
export const compact = (o: Record<string, string | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Record<string, string>;

export interface TeamRow {
  name: string | null; email: string | null; phone: string | null;
  role: string | null; source: string | null; is_dnc: boolean;
}

/**
 * Three lanes (per Stephanie 2026-07-02): the portal "Team" tab = the form
 * filler + anyone named under the introduction questions; the client's own
 * scraped roster -> "Your Agents" (never contacted); intake exclusions -> the
 * dedicated DNC list.
 */
export function teamLanes<T extends TeamRow>(team: T[]): { teamContacts: T[]; roster: T[]; external: T[] } {
  return {
    teamContacts: team.filter((m) => m.source === "typeform" && !m.is_dnc),
    external: team.filter((m) => m.source === "typeform" && m.is_dnc),
    roster: team.filter((m) => m.source !== "typeform"),
  };
}

export const teamContactBody = (m: TeamRow) =>
  compact({ name: m.name, email: m.email, title: m.role ?? "Team Member", phone: m.phone });
export const rosterBody = (m: TeamRow) => compact({ name: m.name, email: m.email, phone: m.phone });
export const dncBody = (m: TeamRow) => compact({ name: m.name });

/* ------------------------------ Health Dash ------------------------------ */

export function healthDashBody(c: PayloadClient): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: c.client_name,
    plan: c.plan ?? "production",
    weekly_target: c.weekly_target ?? 3,
  };
  // start_date = onboarding date if we ever capture it; created_at is a reasonable default.
  if (c.created_at) body.start_date = String(c.created_at).slice(0, 10);
  return body;
}

/* --------------------------------- Bison --------------------------------- */

// Schedule template id per client timezone (discovered from the live workspace).
export const SCHEDULE_BY_TZ: Record<string, number> = { EST: 2, CST: 15, MST: 20, PST: 13 };

export function scheduleIdFor(timezone: string | null | undefined): number {
  return SCHEDULE_BY_TZ[(timezone || "EST").toUpperCase()] ?? SCHEDULE_BY_TZ.EST;
}

// Nicole Collins is the ONLY Talent Acquisition agent / campaign sender for ALL clients
// (Stephanie, 2026-07-08). Campaigns are locked to her pool; Bison-side manual edits stay possible.
export const PERSONA = "Nicole";
export const PERSONA_FULL = "Nicole Collins";
export const PERSONA_POOL = "Nicole Pool";

/** Campaign name: "ClientName + Sender + MLS/Location". */
export function campaignName(c: PayloadClient): string {
  return [c.client_name, PERSONA, c.mls || c.location].filter(Boolean).join(" + ");
}

/** Convert template first-name placeholders to Bison's {FIRST_NAME}; fill client-constant vars. */
export function toBisonBody(body: string, vars: Record<string, string>): string {
  const filled = render(body, vars); // fills {{Brokerage Name}}, {{Sender Name}}; leaves {{firstName}} etc.
  return filled.replace(/\{\{\s*(first[_\s]?name)\s*\}\}/gi, "{FIRST_NAME}");
}

export interface CopyTemplate { subject: string | null; body: string; sort: number }

/** Step 13 — S1/S2/S3 from the "campaign_copy" templates. Bison requires a subject on every step; thread_reply keeps them one thread. */
export function bisonSequenceSteps(copies: CopyTemplate[], fallbackSubject: string, vars: Record<string, string>) {
  const sorted = [...copies].sort((a, b) => a.sort - b.sort);
  const s1Subject = toBisonBody(sorted[0]?.subject ?? fallbackSubject, vars);
  const subjectVars = Array.from(new Set(s1Subject.match(/\{[A-Z_]+\}/g) || [])); // only vars actually in the subject
  return sorted.slice(0, 3).map((t, i) => ({
    order: i + 1,
    email_subject: s1Subject,
    email_subject_variables: subjectVars,
    email_body: toBisonBody(t.body, vars),
    wait_in_days: i === 0 ? 1 : 2,
    variant: false,
    thread_reply: i > 0, // S2/S3 reply in the same thread
  }));
}

/** Monday 00:00 UTC of the current ISO week — the window the weekly-target pause counts. */
export function isoWeekStart(now: Date): Date {
  const weekStart = new Date(now);
  const day = (weekStart.getUTCDay() + 6) % 7; // Monday=0
  weekStart.setUTCDate(weekStart.getUTCDate() - day);
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart;
}
