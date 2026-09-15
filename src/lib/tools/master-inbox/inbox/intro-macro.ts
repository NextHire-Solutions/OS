/*
 * The introduction macro — one wording, rendered two ways.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 *
 * The same paragraph is produced in two places and they must never drift:
 *
 *   1. Onboarding a client writes an "Intro Macro - <client>" row into
 *      `reply_templates`, so the wording is in the Templates picker and in
 *      the standalone Master Inbox as well.
 *   2. The Introduce button in the composer renders it on demand, from the
 *      client's CURRENT details, so correcting a role or a brokerage in
 *      Clients → Edit changes what the next introduction says.
 *
 * Before this module the wording lived inline in the clients API route and
 * (2) did not exist. Both now call `renderIntroMacroTemplate`.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF VALUE
 *
 * The client's values (who is being introduced) are known when a template is
 * written, so they are substituted HERE, into literal text.
 *
 * The lead's values (who is being introduced TO) are only known when a
 * particular conversation is open, so they stay as `{{lead.*}}` placeholders
 * and are resolved by `substituteVariables` at insert time — the same
 * substitution the Templates picker has always used, so a macro inserted by
 * the button and one inserted from the picker read identically.
 */

export interface IntroMacroClient {
  /** The client's name on the roster. Used when `brokerage` is empty. */
  name: string;
  /** Who the agent is introduced to: "Nicole Collins". */
  contactName: string | null;
  /** Their role, as it reads in the sentence: "Team Leader". */
  contactRole: string | null;
  /** The brokerage named in the body and the sign-off. */
  brokerage: string | null;
  /**
   * Overrides the first name derived from `contactName`.
   *
   * The clients API has always taken `client_first_name` as its own field, so
   * a caller that sends something other than the first word keeps getting
   * exactly what it sent. Everything else derives it.
   */
  contactFirstName?: string | null;
}

/** The fields the macro cannot be written without. */
export const REQUIRED_INTRO_FIELDS = ["contactName", "contactRole"] as const;

/**
 * Which required values are missing, as labels fit for a tooltip.
 *
 * `brokerage` is not required: it falls back to the client's own name, which
 * is what the Onboard dialog has always done with an empty brokerage field.
 */
export function missingIntroFields(client: IntroMacroClient): string[] {
  const out: string[] = [];
  if (!client.contactName?.trim()) out.push("contact name");
  if (!client.contactRole?.trim()) out.push("their role");
  return out;
}

export function hasIntroDetails(client: IntroMacroClient): boolean {
  return missingIntroFields(client).length === 0;
}

/**
 * First word of a name: "Nicole Collins" → "Nicole".
 *
 * Deliberately simple — the Onboard dialog has always derived the first name
 * this way, and matching it keeps templates written before this module and
 * after it identical.
 */
export function firstNameOf(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * The macro, with the client's details filled in and the lead's left as
 * `{{lead.*}}` placeholders.
 *
 * Byte-for-byte the wording that has been going into `reply_templates` since
 * onboarding was built; a test pins it so an edit here cannot silently change
 * what every existing client's template says.
 */
export function renderIntroMacroTemplate(client: IntroMacroClient): string {
  const brokerage = (client.brokerage ?? "").trim() || client.name;
  const fullName = (client.contactName ?? "").trim();
  const role = (client.contactRole ?? "").trim();
  const firstName = (client.contactFirstName ?? "").trim() || firstNameOf(fullName);

  return (
    `Hey {{lead.name}},\n\n` +
    `I'd like to introduce you to ${fullName}, ${role} at ${brokerage}\n\n` +
    `${firstName}, I recently connected with {{lead.first_name}}, ` +
    `who can be reached directly at {{lead.phone_number}} and is currently with {{lead.company}}.\n\n` +
    `{{lead.first_name}}, ${firstName} will be in touch directly to ` +
    `learn more about your business and discuss the opportunity in greater detail.\n\n` +
    `I hope you have a productive conversation!\n\n` +
    `Best,\n{{sender.name}}\nTalent Acquisition | ${brokerage}`
  );
}

/** The name given to a client's stored template. Used to find it again. */
export function introTemplateName(clientName: string): string {
  return `Intro Macro - ${clientName}`;
}
