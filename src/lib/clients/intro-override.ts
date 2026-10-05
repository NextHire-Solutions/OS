import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { syncIntroTemplate, type IntroTemplateOutcome } from "@/lib/clients/intro-template-sync";
import {
  customIntro,
  introReady,
  moreContactsFrom,
  missingIntroFields,
  renderIntroMacroTemplate,
  type IntroMacroClient,
} from "@/lib/tools/master-inbox/inbox/intro-macro";

/*
 * A client's own introduction (os_clients.intro_override, OS migration 0026).
 *
 * When set it is what the Introduce button, the reply agent's handover and
 * the stored "Intro Macro - <client>" template send, in place of the
 * standard wording. Blank means the standard wording.
 *
 * Every read tolerates the column not existing yet: before 0026 runs a
 * client simply has no custom intro.
 */

export class IntroOverrideError extends Error {}

/** Longer than any introduction anyone would paste; stops a runaway paste. */
export const INTRO_OVERRIDE_MAX = 5000;

const missingColumn = (msg: string) => /intro_override/.test(msg);

/** The client's custom intro, or null (none set, or 0026 not run). */
export async function readIntroOverride(clientId: string): Promise<string | null> {
  const { data, error } = await osTable("os_clients").select("intro_override").eq("id", clientId).maybeSingle();
  if (error) {
    if (missingColumn(error.message)) return null;
    throw new Error(error.message);
  }
  return ((data as { intro_override?: string | null } | null)?.intro_override ?? "").trim() || null;
}

const CLIENT_COLS =
  "id, name, contact_name, contact_role, contact_email, " +
  "contact2_name, contact2_role, contact2_email, " +
  "contact3_name, contact3_role, contact3_email, brokerage";

/** People 4+ (0028); none before the migration. */
async function readMore(clientId: string) {
  const { data, error } = await osTable("os_clients").select("more_contacts").eq("id", clientId).maybeSingle();
  return error ? [] : moreContactsFrom((data as { more_contacts?: unknown } | null)?.more_contacts);
}

async function macroClient(clientId: string): Promise<IntroMacroClient> {
  const { data, error } = await osTable("os_clients").select(CLIENT_COLS).eq("id", clientId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new IntroOverrideError("No such client.");
  const row = data as unknown as Record<string, string | null>;
  return {
    name: row.name ?? "",
    contactName: row.contact_name,
    contactRole: row.contact_role,
    contactEmail: row.contact_email,
    extraContacts: [
      ...[2, 3].map((n) => ({
        name: row[`contact${n}_name`],
        role: row[`contact${n}_role`],
        email: row[`contact${n}_email`],
      })),
      ...(await readMore(clientId)),
    ],
    brokerage: row.brokerage,
    introOverride: await readIntroOverride(clientId),
  };
}

export interface IntroView {
  /** The standard wording from the contacts, or null when they are incomplete. */
  standard: string | null;
  /** What is missing for the standard wording ("contact name and role"). */
  missing: string[];
  /** The client's own introduction, when set. */
  custom: string | null;
  /** Whether there is an introduction to send at all. */
  ready: boolean;
  /** False until migration 0026 has run: a custom intro cannot be saved yet. */
  canSaveCustom: boolean;
}

export async function introView(clientId: string): Promise<IntroView> {
  const client = await macroClient(clientId);
  const missing = missingIntroFields(client);
  const probe = await osTable("os_clients").select("intro_override").limit(1);
  return {
    standard: missing.length ? null : renderIntroMacroTemplate(client),
    missing,
    custom: customIntro(client),
    ready: introReady(client),
    canSaveCustom: !probe.error,
  };
}

/**
 * Save (or clear, with null / blank) the client's custom intro, then bring
 * the stored "Intro Macro" template in step. The column write is what
 * matters; a template sync failure is reported, not thrown.
 */
export async function saveIntroOverride(
  clientId: string,
  text: string | null,
): Promise<{ view: IntroView; template: IntroTemplateOutcome | "failed" }> {
  const value = (text ?? "").replace(/\r\n/g, "\n").trim() || null;
  if (value && value.length > INTRO_OVERRIDE_MAX) {
    throw new IntroOverrideError(`The introduction is too long (${value.length} characters; the limit is ${INTRO_OVERRIDE_MAX}).`);
  }
  const { error } = await osTable("os_clients")
    .update({ intro_override: value, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) {
    if (missingColumn(error.message)) {
      throw new IntroOverrideError("Custom introductions need database migration 0026 first.");
    }
    throw new Error(error.message);
  }
  let template: IntroTemplateOutcome | "failed";
  try {
    template = await syncIntroTemplate(await macroClient(clientId));
  } catch (e) {
    console.error("[intro-override] template sync", e);
    template = "failed";
  }
  return { view: await introView(clientId), template };
}
