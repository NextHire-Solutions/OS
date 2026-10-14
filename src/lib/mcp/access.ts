import "server-only";

import { isAdminUser } from "@/lib/identity/admin-db";
import { grantStore } from "@/lib/identity/store";

import type { UserCheck } from "./oauth.ts";

/*
 * Who may connect Claude, asked fresh at every step — sign-in, token refresh
 * and EVERY request to the MCP endpoint.
 *
 * The rule is the Assistant's (tools/assistant/access.ts): workspace admins
 * only, because the tools read across every client and every product at once.
 * Read live, so deactivating someone, taking away admin, a password change
 * (token_version) or "log everyone out" ends their connector at once.
 */
export const connectorUserCheck: UserCheck = async (email) => {
  const user = await grantStore().findByEmail(email);
  if (!user) return { ok: false, reason: "This BrokerStaffer OS account is not active." };
  if (user.mustChangePassword) {
    return { ok: false, reason: "Change your temporary password in BrokerStaffer OS first (Account), then connect Claude." };
  }
  if (!(await isAdminUser(email))) {
    return { ok: false, reason: "Only workspace admins can connect Claude to BrokerStaffer OS." };
  }
  return { ok: true, ver: user.tokenVersion };
};
