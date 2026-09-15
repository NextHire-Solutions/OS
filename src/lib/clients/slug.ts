/*
 * Master Inbox's slug rule, copied exactly.
 *
 * Pure and dependency-free on purpose: both the link resolver (server-only)
 * and the onboarding planner (unit-tested) need it, and a slug computed two
 * different ways would mean a client minted in the OS and the same client
 * minted in Master Inbox disagreeing about its own address — `slug` is what
 * the portal token is prefixed with.
 *
 * From Master Inbox's app/api/clients/route.ts:
 *
 *   lowercase → "&" becomes "and" → every other non-alphanumeric run becomes
 *   "-" → trim leading/trailing "-" → cap at 60 → fall back to "client".
 */
export function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "client"
  );
}
