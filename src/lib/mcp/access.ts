import "server-only";

import { isAdminUser } from "@/lib/identity/admin-db";
import { holdsPage } from "@/lib/identity/named-pages";
import { grantStore } from "@/lib/identity/store";

import type { UserCheck } from "./oauth.ts";

/*
 * Who may connect Claude, asked fresh at every step — sign-in, token refresh
 * and EVERY request to the MCP endpoint.
 *
 * The rule is the Assistant's (tools/assistant/access.ts): workspace admins, and (25 Nov) people named for the
 * connector, who get only the tools their switches open (mcp/tools.ts).
 * Read live, so deactivating someone, taking away admin, a password change
 * (token_version) or "log everyone out" ends their connector at once.
 */
export const connectorUserCheck: UserCheck = async (email) => {
  const user = await grantStore().findByEmail(email);
  if (!user) return { ok: false, reason: "This BrokerStaffer OS account is not active." };
  if (user.mustChangePassword) {
    return { ok: false, reason: "Change your temporary password in BrokerStaffer OS first (Account), then connect Claude." };
  }
  // 25 Nov: admins, and people named for the connector (identity/named-pages.ts "claude-connector") — who then get only
  // what their switches open (mcp/tools.ts).
  if (!(await isAdminUser(email)) && !holdsPage(email, "claude-connector")) {
    return { ok: false, reason: "Only workspace admins, and people an admin has opened it to, can connect Claude to BrokerStaffer OS." };
  }
  return { ok: true, ver: user.tokenVersion };
};
