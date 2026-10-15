/*
 * Changing a portal's URL from the OS — safely (16 Oct).
 *
 * A portal's URL is its token (/portal/<token>), and the token is the only
 * thing that finds it. Until 16 Oct the OS refused to change it at all
 * (portal-guard.ts assertPortalUrlStable): a new token killed every link the
 * client already had. Amy needed Jeff Cook's changed, and the user: "we need a
 * system to control things from here" — the OS, not the old Master Inbox.
 *
 * So a change is allowed when the old link keeps working: Master Inbox
 * migration 0079 keeps a portal's old tokens (portal_token_aliases, written by
 * a trigger on every change) and the portal forwards an old link to the
 * current one. Without that table the OS still refuses, and says why.
 *
 * Keeping the old link is the default. It can be dropped on purpose — when the
 * reason for a new URL is that the old one went somewhere it should not have.
 */

export const ALIAS_TABLE = "portal_token_aliases";
export const ALIAS_MIGRATION = "0079_portal_token_aliases.sql";

export const NEEDS_MIGRATION =
  "Changing a portal's URL needs Master Inbox migration 0079 first — it is what keeps the client's old link working. Nothing was changed.";

/** PostgREST's "no such table" (PGRST205 / 42P01), so the change is refused rather than done unsafely. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes(ALIAS_TABLE) && (m.includes("does not exist") || m.includes("schema cache") || m.includes("could not find"));
}

/**
 * Why a new URL cannot be used for this portal, or null when it can.
 *   - the same as now: nothing to change
 *   - another portal's OLD link: it would take over that portal's old links
 *     (the database refuses it too — the trigger in 0079)
 */
export function linkChangeProblem(next: string, current: string | null, aliasOwner: string | null, portalId: string): string | null {
  if (next === current) return "That is already this portal's URL.";
  if (aliasOwner && aliasOwner !== portalId) return "That URL was used by another portal before — pick another.";
  return null;
}
