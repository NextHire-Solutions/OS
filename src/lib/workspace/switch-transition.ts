import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";

/*
 * The switch split of 15 Oct, for sessions started before it.
 *
 * A session carries the switches it was signed with, and is renewed every ten
 * minutes (session-keeper.tsx). A session signed BEFORE the split knows
 * nothing of the new switches: its `analytics` opened Campaign Analytics,
 * Campaign Management and Inboxes, and the Account manager role opened
 * Clients and Commissions. Read literally after the deploy, everyone at work
 * would lose Campaign Management and Inboxes from the menu — be sent Home
 * mid-task — until their session renewed, and Amy and Gabriel would lose
 * Clients and Commissions too.
 *
 * So a pre-split session is read the way it was meant when it was signed.
 * Every session is renewed within 30 minutes (SSO_TTL_MS), so after
 * SWITCH_SPLIT_AT + 30 min there are none left and this does nothing.
 * Sessions signed after it carry the real switches and are read as they are.
 *
 * SWITCH_SPLIT_AT is set after the deploy, not at it: a session signed by the
 * new code in between is also read the old way, which only ever adds what the
 * person had that day (everyone who saw those pages had their switches turned
 * on at the deploy).
 */
export const SWITCH_SPLIT_AT = Date.parse("2026-10-15T17:00:00Z");

export function isPreSplitSession(iat: number): boolean {
  return Number.isFinite(iat) && iat < SWITCH_SPLIT_AT;
}

/** The tools a pre-split session meant: its `analytics` opened all three sections. The proxy uses this. */
export function preSplitToolGrants(grants: readonly ToolId[], iat: number): ToolId[] {
  if (!isPreSplitSession(iat) || !grants.includes("analytics")) return [...grants];
  return ALL_TOOLS.filter((t) => grants.includes(t) || t === "campaigns" || t === "inboxes");
}

/**
 * Plus the pages its roles opened — Clients and Commissions for an account
 * manager, Commissions for a salesperson. Needs the roles, so the page and the
 * page guards use this; the proxy cannot.
 */
export function preSplitPageGrants(
  grants: readonly ToolId[],
  preSplit: boolean,
  roles: { accountManager?: boolean; salesperson?: boolean },
): ToolId[] {
  if (!preSplit) return [...grants];
  const add = new Set<ToolId>();
  if (roles.accountManager) { add.add("roster"); add.add("commissions"); }
  if (roles.salesperson) add.add("commissions");
  return ALL_TOOLS.filter((t) => grants.includes(t) || add.has(t));
}

/** A session's switches as every page check on the server reads them — both of the above. */
export function sessionPageGrants(
  session: { grants: readonly ToolId[]; iat: number },
  roles: { accountManager?: boolean; salesperson?: boolean },
): ToolId[] {
  return preSplitPageGrants(preSplitToolGrants(session.grants, session.iat), isPreSplitSession(session.iat), roles);
}
