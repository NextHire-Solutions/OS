import "server-only";

import { isAdmin } from "./admin";
import { DbGrantStore, grantStore } from "./store";
import { matchTeamMember, type TeamMember } from "./team-match";

export { matchTeamMember, type TeamMember } from "./team-match";

/*
 * THE TEAM, as Team access holds it — the one list of people in the business.
 *
 * Account Manager is a team member (the client's decision, 30 Sep): the
 * master record's Account Manager can only be someone on this list, the
 * Clients page offers exactly this list, and Commissions pays exactly these
 * people. Invite someone on Team access and they can be assigned clients;
 * deactivate them and they drop out of the picker (their existing clients
 * keep the name until someone reassigns them).
 */
export async function listTeamMembers(): Promise<TeamMember[]> {
  const store = grantStore();
  const users = store instanceof DbGrantStore ? await store.listMerged() : await store.listUsers();
  return users.map((u) => {
    const named = "name" in u && typeof u.name === "string" && u.name.trim() ? u.name.trim() : null;
    return {
      email: u.email.toLowerCase(),
      // Someone invited without a name is shown by their address's first part.
      name: named ?? u.email.split("@")[0],
      active: u.isActive !== false,
      admin: isAdmin(u.email),
    };
  });
}

/** The active member the typed name belongs to — the Account Manager rule. */
export async function resolveAccountManager(input: string): Promise<ReturnType<typeof matchTeamMember>> {
  return matchTeamMember(input, (await listTeamMembers()).filter((m) => m.active));
}
