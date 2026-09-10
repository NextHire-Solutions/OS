// Super admin identity check. Driven by env var SUPER_ADMIN_EMAILS so we don't
// have to track a separate `is_super_admin` column in auth.users.
//
// SUPER_ADMIN_EMAILS="admin@outreachify.io,founder@brokerstaffer.com" (comma-separated)
//
// Super admin === automatic owner of every workspace + sole entity that can
// invite new users and re-sync EmailBison teams.

export function isSuperAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

export function getSuperAdminEmails(): string[] {
  return (process.env.SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
