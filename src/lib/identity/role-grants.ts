import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";

/*
 * Products a role brings with it (15 Oct).
 *
 * "Make the Client Portals product accessible to account managers": anyone
 * with the Account manager role on Team access holds Client Portals, whatever
 * their switches say — the same way the role already opens the Clients page
 * (nav.ts canSeePage). A rule rather than switched-on grants, so a new
 * account manager has it from their first sign-in and loses it when the role
 * is taken away (unless Client Portals is also switched on for them).
 *
 * Applied where a person's tools are worked out (identity/store.ts
 * findByEmail), so the session token carries it and the proxy, the menu and
 * every API follow without knowing about roles. Team access shows the switch
 * on and locked for them. Deleting a portal stays admins-only — that is
 * checked by role, not by this grant.
 */
export const ROLE_TOOLS: { accountManager: readonly ToolId[] } = { accountManager: ["portals"] };

/** The person's own grants plus what their roles bring, in ALL_TOOLS order. */
export function withRoleGrants(grants: readonly ToolId[], roles: { accountManager?: boolean }): ToolId[] {
  const extra = roles.accountManager ? ROLE_TOOLS.accountManager : [];
  return ALL_TOOLS.filter((t) => grants.includes(t) || extra.includes(t));
}

/** True when `tool` is on for this person only because of a role — the switch is shown locked. */
export function grantedByRole(tool: string, roles: { accountManager?: boolean }): boolean {
  return !!roles.accountManager && (ROLE_TOOLS.accountManager as readonly string[]).includes(tool);
}
