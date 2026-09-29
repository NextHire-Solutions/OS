import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { ttlCache } from "@/lib/cache/ttl";

import { isAdmin as isOwner } from "./admin";

/*
 * WHO IS AN ADMIN.
 *
 *   Owners   ADMIN_EMAILS. Always admins, never removable from a screen — an
 *            owner who unticked themselves would have nothing left to tick it
 *            back on from.
 *   Admins   anyone marked Admin on Team access (os_users.is_admin, 0021).
 *
 * Both see and edit everything; only an Owner's standing is fixed. Read
 * through a short, process-wide cache (every admin check is one lookup), and
 * dropped the moment Team access changes someone.
 */
const dbAdmins = ttlCache(
  async (): Promise<Set<string>> => {
    const { data, error } = await osTable("os_users").select("email, is_admin, is_active");
    // Before 0021 the column is absent: nobody is an admin from the table.
    if (error) return new Set();
    return new Set(
      ((data ?? []) as unknown as { email: string; is_admin?: boolean; is_active?: boolean }[])
        .filter((r) => r.is_admin === true && r.is_active !== false)
        .map((r) => r.email.toLowerCase()),
    );
  },
  { ttlMs: 30_000, staleMs: 5 * 60_000, shared: "db-admins" },
);

export { isOwner };

export async function isAdminUser(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  if (isOwner(email)) return true;
  return (await dbAdmins()).has(email.trim().toLowerCase());
}

/** Call after Team access changes anyone's admin standing. */
export function adminsChanged(): void {
  dbAdmins.invalidate();
}
