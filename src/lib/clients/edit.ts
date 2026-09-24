import "server-only";

import { osTable } from "./os-db";
import { syncIntroTemplate } from "./intro-template-sync";
import { CLIENT_STATUSES, type ClientStatus } from "./client-status";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { updateClientRow } from "@/lib/tools/client-health/clientWrites";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";

/*
 * Editing a client from the workspace.
 *
 * ---------------------------------------------------------------------------
 * WHAT CAN BE EDITED, AND WHERE IT LANDS
 *
 *   aliases         os_clients + Analytics   the spellings the matchers use
 *   plan            Client Health            billing tier
 *   weeklyTarget    Client Health            introductions promised per week
 *   startDate       Client Health            drives the movement table
 *   billing*        Client Health            anchor date and interval
 *   status          os_clients               onboarding / active / paused / churned
 *   notes           os_clients               ours alone
 *   accountManager  os_clients               §6 field, recorded nowhere before
 *   salesperson     os_clients               §6 field
 *   sender          os_clients               §6 field
 *   market/mls/area os_clients               §6 fields
 *
 * ---------------------------------------------------------------------------
 * HOW THE CLIENT HEALTH LEG WRITES
 *
 * Through `clientWrites.ts` — the same `updateClientRow` the Client Health
 * screens use — straight into that tool's database. It used to PATCH the live
 * tool's /api/clients with a cookie derived from the dashboard password, and
 * that route had a trap: it assigned name / plan / weekly_target / start_date
 * / instantly_campaign_ids UNCONDITIONALLY, so a partial body cleared the
 * campaign links, and every write here had to read the row first and re-send
 * all five fields in full.
 *
 * `updateClientRow` has no such trap. Its `updateValues` applies only the keys
 * that are present, so `{ id, plan }` changes the plan and nothing else. The
 * read-then-resend is therefore gone, and with it the dependency on the live
 * tool and on CLIENT_HEALTH_URL / CLIENT_HEALTH_DASHBOARD_PASSWORD. One
 * validation path for every client write this workspace makes.
 *
 * ---------------------------------------------------------------------------
 * WHAT CANNOT BE EDITED FROM HERE
 *
 * Master Inbox's name and aliases. Its PATCH requires a signed-in browser
 * session, exactly like its DELETE, so the workspace cannot call it — and its
 * tables are off-limits to the guarded client by design. A rename there also
 * rewrites `slug`, which is the prefix of the live portal token's URL path.
 * Renaming is offered as the OS's DISPLAY name only, and the note on screen
 * says so.
 */

export const PLANS = ["minimum", "production", "partner"] as const;
export const BILLING_INTERVALS = ["biweekly", "28-days", "monthly", "custom"] as const;

export interface ClientEdit {
  name?: string;
  aliases?: string[];
  status?: ClientStatus;
  notes?: string | null;
  /*
   * The introduction details. Stored on the OS record and used by the
   * composer's Introduce button; changing any of them also re-renders the
   * client's stored "Intro Macro - <name>" reply template so the Templates
   * picker never shows a stale version. An empty string clears the field.
   */
  contactName?: string | null;
  contactRole?: string | null;
  contactEmail?: string | null;
  /*
   * The second and third people to introduce an agent to. Each is all-or-
   * nothing: a name and a role together, optionally an address. Clearing the
   * name and the role removes that person from the sentence.
   */
  contact2Name?: string | null;
  contact2Role?: string | null;
  contact2Email?: string | null;
  contact3Name?: string | null;
  contact3Role?: string | null;
  contact3Email?: string | null;
  /*
   * The §6 master-record fields (migration 0015). Recorded here because the
   * OS is the master record and because, before this, there was nowhere in
   * any tool to record them: Account Manager was set for 0 clients of 46.
   *
   * A blank string clears the field, exactly like the contact slots above.
   */
  accountManager?: string | null;
  salesperson?: string | null;
  sender?: string | null;
  market?: string | null;
  mls?: string | null;
  area?: string | null;
  brokerage?: string | null;
  plan?: (typeof PLANS)[number];
  weeklyTarget?: number;
  startDate?: string | null;
  billingInterval?: (typeof BILLING_INTERVALS)[number];
  billingAnchorDate?: string | null;
}

export interface EditResult {
  updated: string[];
  failed: { what: string; error: string }[];
  /** Things the workspace deliberately did not change, and why. */
  untouched: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Row {
  id: string;
  name: string;
  an_client_id: string | null;
  ch_client_id: string | null;
  mi_client_id: string | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact2_name: string | null;
  contact2_role: string | null;
  contact2_email: string | null;
  contact3_name: string | null;
  contact3_role: string | null;
  contact3_email: string | null;
  brokerage: string | null;
}

/** Every field that makes up the introduction macro. */
const INTRO_KEYS = [
  "contactName", "contactRole", "contactEmail",
  "contact2Name", "contact2Role", "contact2Email",
  "contact3Name", "contact3Role", "contact3Email",
  "brokerage",
] as const;

/** The three contact slots, so validation and saving can walk them. */
const CONTACT_SLOTS = [
  { ord: "First",  name: "contactName",  role: "contactRole",  email: "contactEmail",
    col: { name: "contact_name",  role: "contact_role",  email: "contact_email"  } },
  { ord: "Second", name: "contact2Name", role: "contact2Role", email: "contact2Email",
    col: { name: "contact2_name", role: "contact2_role", email: "contact2_email" } },
  { ord: "Third",  name: "contact3Name", role: "contact3Role", email: "contact3Email",
    col: { name: "contact3_name", role: "contact3_role", email: "contact3_email" } },
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEdit(edit: ClientEdit): string[] {
  const errors: string[] = [];
  if (edit.name !== undefined && !edit.name.trim()) errors.push("Name cannot be empty.");
  if (edit.name !== undefined && edit.name.length > 80) {
    errors.push(`Name is ${edit.name.length} characters; Master Inbox allows 80.`);
  }
  if (edit.aliases && edit.aliases.length > 20) errors.push("At most 20 aliases.");
  if (edit.status !== undefined && !CLIENT_STATUSES.includes(edit.status)) {
    errors.push(`Status must be one of ${CLIENT_STATUSES.join(", ")}.`);
  }
  if (edit.plan !== undefined && !PLANS.includes(edit.plan)) {
    errors.push(`Plan must be one of ${PLANS.join(", ")}.`);
  }
  if (edit.weeklyTarget !== undefined &&
      (!Number.isInteger(edit.weeklyTarget) || edit.weeklyTarget < 0)) {
    errors.push("Weekly target must be a whole number of 0 or more.");
  }
  for (const [label, v] of [["Start date", edit.startDate], ["Billing anchor date", edit.billingAnchorDate]] as const) {
    if (v && !ISO_DATE.test(v)) errors.push(`${label} must be YYYY-MM-DD.`);
  }
  if (edit.billingInterval !== undefined && !BILLING_INTERVALS.includes(edit.billingInterval)) {
    errors.push(`Billing interval must be one of ${BILLING_INTERVALS.join(", ")}.`);
  }
  const lengths: Array<readonly [string, unknown, number]> = [["Brokerage", edit.brokerage, 160]];
  for (const slot of CONTACT_SLOTS) {
    lengths.push([`${slot.ord} contact name`, edit[slot.name], 160]);
    lengths.push([`${slot.ord} contact's role`, edit[slot.role], 120]);
  }
  for (const [label, v, max] of lengths) {
    if (typeof v === "string" && v.length > max) {
      errors.push(`${label} is ${v.length} characters; the introduction template allows ${max}.`);
    }
  }
  for (const slot of CONTACT_SLOTS) {
    // An empty string clears the address; anything else has to be one.
    const email = edit[slot.email];
    if (typeof email === "string" && email.trim() && !EMAIL.test(email.trim())) {
      errors.push(`${slot.ord} contact email must be a valid email address.`);
    }
  }
  /*
   * Half a person is refused too, but not here.
   *
   * An edit carries only the fields that CHANGED — correcting a role sends
   * the role and nothing else — so this function cannot tell "no name" from
   * "the name is already stored". That check needs the saved row, so it lives
   * in `settledContacts` and runs inside `editClient`.
   */
  return errors;
}

/**
 * Each contact slot as it will stand AFTER this edit, and what is wrong with it.
 *
 * The edit supplies a value only for what changed, so every field falls back
 * to the stored one. That is the only way to tell someone correcting a role
 * apart from someone leaving a person half-filled in.
 *
 * The sentence reads "<name>, <role>". A name with no role would render
 * "Shaurs Patel, at Oz Group"; a role with no name reads as a stray phrase.
 * Either is refused before anything is written.
 */
/**
 * The caller sent something that cannot be saved.
 *
 * Distinct from every other failure `editClient` can throw, which are upstream
 * problems. The route answers this one with 400 and the message, and the other
 * kind with 502 — so a person correcting a contact reads "Second contact needs
 * a role as well as a name" instead of a server error.
 */
export class InvalidEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEditError";
  }
}

export function settledContacts(
  edit: ClientEdit,
  row: Pick<Row, "contact_name" | "contact_role" | "contact_email" |
    "contact2_name" | "contact2_role" | "contact2_email" |
    "contact3_name" | "contact3_role" | "contact3_email">,
): { people: Array<{ name: string | null; role: string | null; email: string | null }>; errors: string[] } {
  const blank = (v: string | null | undefined) => (v ?? "").trim() || null;
  const errors: string[] = [];
  const people = CONTACT_SLOTS.map((slot) => {
    const person = {
      name: edit[slot.name] !== undefined ? blank(edit[slot.name]) : row[slot.col.name],
      role: edit[slot.role] !== undefined ? blank(edit[slot.role]) : row[slot.col.role],
      email: edit[slot.email] !== undefined ? blank(edit[slot.email]) : row[slot.col.email],
    };
    // Only complain about a slot this edit actually touched, so correcting a
    // plan never trips over a contact someone left half-filled months ago.
    const touched = [slot.name, slot.role, slot.email].some((k) => edit[k] !== undefined);
    if (touched) {
      if (person.name && !person.role) errors.push(`${slot.ord} contact needs a role as well as a name.`);
      if (person.role && !person.name) errors.push(`${slot.ord} contact needs a name as well as a role.`);
    }
    return person;
  });
  return { people, errors };
}

export async function editClient(id: string, edit: ClientEdit): Promise<EditResult> {
  const errors = validateEdit(edit);
  if (errors.length) throw new Error(errors.join(" "));

  const { data, error } = await osTable("os_clients")
    .select(
      "id, name, an_client_id, ch_client_id, mi_client_id, " +
        "contact_name, contact_role, contact_email, " +
        "contact2_name, contact2_role, contact2_email, " +
        "contact3_name, contact3_role, contact3_email, brokerage",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the client: ${error.message}`);
  if (!data) throw new Error("No such client");
  const row = data as unknown as Row;

  // Refused before anything is written, so a rejected edit changes nothing.
  const settledNow = settledContacts(edit, row);
  if (settledNow.errors.length) throw new InvalidEditError(settledNow.errors.join(" "));

  const updated: string[] = [];
  const failed: EditResult["failed"] = [];
  const untouched: string[] = [];

  /* ---------------------------------------------------------- os_clients */
  const local: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (edit.name !== undefined) local.name = edit.name.trim();
  if (edit.aliases !== undefined) local.aliases = edit.aliases;
  if (edit.status !== undefined) local.status = edit.status;
  if (edit.notes !== undefined) local.notes = edit.notes;
  // A blank field is a deliberate clear, not "leave it alone" — the dialog
  // only sends a key when its value actually changed.
  const blankToNull = (v: string | null | undefined) => (v ?? "").trim() || null;
  for (const slot of CONTACT_SLOTS) {
    if (edit[slot.name] !== undefined) local[slot.col.name] = blankToNull(edit[slot.name]);
    if (edit[slot.role] !== undefined) local[slot.col.role] = blankToNull(edit[slot.role]);
    if (edit[slot.email] !== undefined) local[slot.col.email] = blankToNull(edit[slot.email]);
  }
  if (edit.brokerage !== undefined) local.brokerage = blankToNull(edit.brokerage);
  // §6 master-record fields. OS owns these outright — nothing is sent onward
  // to any tool, because no tool has anywhere to put them.
  if (edit.accountManager !== undefined) local.account_manager = blankToNull(edit.accountManager);
  if (edit.salesperson !== undefined) local.salesperson = blankToNull(edit.salesperson);
  if (edit.sender !== undefined) local.sender_name = blankToNull(edit.sender);
  if (edit.market !== undefined) local.market = blankToNull(edit.market);
  if (edit.mls !== undefined) local.mls = blankToNull(edit.mls);
  if (edit.area !== undefined) local.area = blankToNull(edit.area);
  if (Object.keys(local).length > 1) {
    const { error: e } = await osTable("os_clients").update(local).eq("id", id);
    if (e) failed.push({ what: "the OS record", error: e.message });
    else updated.push("the OS record");
  }

  /* ------------------------------------------ the stored intro template */
  /*
   * Only when an introduction field was actually edited. Re-rendered from the
   * values AFTER this edit, so the template and the roster agree. Never fatal:
   * the OS record above is already saved and the Introduce button reads from
   * it, not from here.
   */
  if (INTRO_KEYS.some((k) => edit[k] !== undefined)) {
    const settled = settledNow.people;
    const after = {
      name: row.name,
      contactName: settled[0].name,
      contactRole: settled[0].role,
      contactEmail: settled[0].email,
      extraContacts: settled.slice(1),
      brokerage: edit.brokerage !== undefined ? blankToNull(edit.brokerage) : row.brokerage,
    };
    try {
      const outcome = await syncIntroTemplate(after);
      if (outcome === "updated") updated.push("the stored introduction template");
      else if (outcome === "created") updated.push("the stored introduction template (created)");
      else if (outcome === "no-details") {
        untouched.push(
          "The stored introduction template was left alone — a contact name and role are needed to write one.",
        );
      } else if (outcome === "no-workspace") {
        untouched.push(
          "The stored introduction template was left alone — MASTER_INBOX_WORKSPACE_ID is not set.",
        );
      }
    } catch (e) {
      failed.push({
        what: "the stored introduction template",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /* ----------------------------------------------------------- Analytics */
  if (edit.aliases !== undefined && row.an_client_id) {
    try {
      const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
      if (!secret) throw new Error("ANALYTICS_AUTH_SECRET not set");
      const token = await mintAnalyticsSession(
        secret,
        optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com",
      );
      const res = await fetch(`${baseUrlEnv("ANALYTICS_URL")}/api/clients/${row.an_client_id}`, {
        method: "PATCH",
        headers: { cookie: `bsa_session=${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ aliases: edit.aliases }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      updated.push("Analytics aliases");
    } catch (e) {
      failed.push({ what: "Analytics aliases", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /* -------------------------------------------------------- Client Health */
  const touchesHealth =
    edit.plan !== undefined || edit.weeklyTarget !== undefined ||
    edit.startDate !== undefined || edit.billingInterval !== undefined ||
    edit.billingAnchorDate !== undefined;

  if (touchesHealth && row.ch_client_id) {
    try {
      // Only what was asked for. `updateClientRow` applies present keys and
      // leaves every other column alone — see the note at the top.
      const body: Record<string, unknown> = { id: row.ch_client_id };
      if (edit.plan !== undefined) body.plan = edit.plan;
      if (edit.weeklyTarget !== undefined) body.weekly_target = edit.weeklyTarget;
      if (edit.startDate !== undefined) body.start_date = edit.startDate;
      if (edit.billingInterval !== undefined) body.billing_interval = edit.billingInterval;
      if (edit.billingAnchorDate !== undefined) body.billing_anchor_date = edit.billingAnchorDate;

      const result = await updateClientRow(getClientHealthDb(), body);
      if (!result.ok) throw new Error(result.error);
      updated.push("Client Health plan and targets");
    } catch (e) {
      failed.push({ what: "Client Health", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /* ------------------------------------------------------- Master Inbox */
  if ((edit.name !== undefined || edit.aliases !== undefined) && row.mi_client_id) {
    untouched.push(
      "Master Inbox keeps its own name and aliases — its update endpoint needs a " +
        "signed-in browser session, and renaming there rewrites the slug that prefixes " +
        "the live portal URL. Change it in Master Inbox if it needs to match.",
    );
  }

  return { updated, failed, untouched };
}
