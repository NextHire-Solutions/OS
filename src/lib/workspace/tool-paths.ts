// Relative with the extension, not the `@/` alias: this module is unit-tested
// with `node --test`, which resolves neither.
import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";

/*
 * Which tool a request belongs to, from its path alone.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The proxy used to pass `x-bs-grants` to the shell so the sidebar could hide
 * ungranted tools, with a comment saying the apps enforce it themselves. That
 * was true when the tools were five separate deployments. It stopped being
 * true when the workspace started HOSTING them: `/api/tools/analytics/*` is
 * this app's route, and nobody downstream checks anything.
 *
 * The result was that a user granted one tool could open every other tool's
 * screens by typing the URL, and two of their API routes returned live data.
 * Hiding a tool in the sidebar is cosmetic; this is the enforcement.
 *
 * ---------------------------------------------------------------------------
 * PURE, AND SEPARATE FROM THE PROXY, SO IT CAN BE TESTED
 *
 * The proxy runs on the Edge and is awkward to exercise directly. The mapping
 * is the part that can be wrong — a missed prefix is a silent hole — so it
 * lives here with tests, and the proxy just calls it.
 */

/*
 * SCREEN prefixes. Keyed by the first path segment the workspace routes under
 * (`src/lib/workspace/nav.ts` builds `/{tool}/{leaf}`), except Client Health,
 * which the workspace addresses as `/clients` for historical reasons.
 */
const SCREEN_PREFIX: Record<string, ToolId> = {
  inbox: "inbox",
  clients: "clients",
  analytics: "analytics",
  onboarding: "onboarding",
  search: "search",
};

/*
 * API prefixes. These are the ones that actually carry data, and they do NOT
 * match the screen names — `/api/tools/master-inbox/*` serves the tool the
 * workspace calls `inbox`. Getting this table wrong in either direction is the
 * whole risk: too loose and a tool stays open, too strict and a granted user
 * is locked out of their own tool.
 */
const API_SEGMENT: Record<string, ToolId> = {
  "master-inbox": "inbox",
  "client-health": "clients",
  analytics: "analytics",
  onboarding: "onboarding",
  "agent-search": "search",
};

/**
 * The tool a path belongs to, or null when it is not tool-specific.
 *
 * Null means the workspace's own surface — Home, Performance, the Clients
 * roster, Team access, `/api/workspace/*`.
 *
 * THOSE ARE DELIBERATELY OPEN TO ANY SIGNED-IN USER, and it is a decision
 * rather than an oversight. The Clients roster aggregates plans, weekly targets
 * and per-tool figures, so someone granted only Agent Search can still read it.
 * That was raised with the business on 2026-09-15 and accepted: the client list
 * is general company information. Per-TOOL data stays gated — the same person
 * cannot open Client Health or Master Inbox.
 *
 * If that ever changes, gate it here rather than in the proxy, so the rule
 * stays in the one place that is unit-tested.
 */
export function toolForPath(pathname: string): ToolId | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  if (parts[0] === "api") {
    // /api/tools/<segment>/...
    if (parts[1] !== "tools" || !parts[2]) return null;
    return API_SEGMENT[parts[2]] ?? null;
  }

  return SCREEN_PREFIX[parts[0]] ?? null;
}

/** Every tool id, for tests that must not drift from the source list. */
export function knownTools(): readonly ToolId[] {
  return ALL_TOOLS;
}
