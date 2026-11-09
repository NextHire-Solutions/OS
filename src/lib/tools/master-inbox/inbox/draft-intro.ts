/*
 * What the Introduce button put in a reply, kept with the saved draft (10 Nov; OS migration 0051), so an introduction
 * that's left and reopened before it's sent still tags the thread Introduction. Amy, 9 Nov: Isaac Hernandez's intro
 * (FAST) was written with Introduce, the thread was left and reopened, and it was sent from the restored draft; the
 * reopened composer didn't know it was an introduction, so the thread stayed Interested and never reached the portal.
 *
 * The rule doesn't change (the user, 18 Sep): only the Introduce button tags, and only while what it inserted is still
 * in what's sent (intro-macro.ts introWasSent). Before 0051 is run, drafts save and load as they always have, without it.
 */

export const DRAFT_INTRO_COLUMN = "intro_inserted";
/** As the column's CHECK (0051): an introduction is a few hundred words. */
export const DRAFT_INTRO_MAX = 20_000;

/** PostgREST's answer when the column isn't there yet (before 0051): that, and nothing else. */
export function draftIntroColumnMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const message = error.message ?? "";
  return message.includes(DRAFT_INTRO_COLUMN) && (error.code === "42703" || error.code === "PGRST204" || /does not exist|could not find/i.test(message));
}
