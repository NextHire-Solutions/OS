/*
 * Which tables the OS may touch in Master Inbox's database.
 *
 * Deliberately a separate module with no `server-only` import, so the rule can
 * be unit-tested. The connection itself lives in os-db.ts; this is the policy,
 * and the policy is the part that could quietly widen.
 *
 * The stakes: that database holds `clients.portal_token`, the address of 47
 * live, login-free customer portals. A service-role connection can write to
 * any of its ~40 tables. This list is what stops it.
 */

export const OS_TABLES = ["os_clients", "os_client_onboarding", "os_tool_grants", "os_users"] as const;
export type OsTable = (typeof OS_TABLES)[number];

export class NotAnOsTableError extends Error {
  constructor(table: string) {
    super(
      `Refusing to reach "${table}" through the OS client. ` +
        `Only ${OS_TABLES.join(" and ")} are allowed here — ` +
        `Master Inbox's own tables are written through its API, never directly. ` +
        `See src/lib/clients/os-db.ts.`,
    );
    this.name = "NotAnOsTableError";
  }
}

export function isOsTable(table: string): table is OsTable {
  return (OS_TABLES as readonly string[]).includes(table);
}
