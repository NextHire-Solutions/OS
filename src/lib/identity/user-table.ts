/*
 * The os_users table, as pure functions.
 *
 * Everything that can be unit-tested without a database lives here: the shape
 * of a stored row, how a temporary password is made, and how invited people
 * merge with the AUTH_USERS allow-list. store.ts does the I/O.
 */
import type { ToolId } from "../bs-auth.ts";
import type { StoredUser } from "./store.ts";

export interface UserRow {
  email: string;
  name: string | null;
  passwordHash: string;
  mustChangePassword: boolean;
  isActive: boolean;
  tokenVersion: number;
  createdAt: string | null;
  createdBy: string | null;
}

/** A row as Supabase returns it; every field is treated as untrusted. */
export function coerceUserRow(raw: Record<string, unknown>): UserRow | null {
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const hash = typeof raw.password_hash === "string" ? raw.password_hash.trim().toLowerCase() : "";
  if (!email || !hash) return null;
  return {
    email,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    passwordHash: hash,
    mustChangePassword: raw.must_change_password !== false,
    isActive: raw.is_active !== false,
    tokenVersion: typeof raw.token_version === "number" && raw.token_version > 0 ? raw.token_version : 1,
    createdAt: typeof raw.created_at === "string" ? raw.created_at : null,
    createdBy: typeof raw.created_by === "string" ? raw.created_by : null,
  };
}

export function indexUserRows(rows: Array<Record<string, unknown>>): Map<string, UserRow> {
  const out = new Map<string, UserRow>();
  for (const raw of rows) {
    const row = coerceUserRow(raw);
    if (row) out.set(row.email, row);
  }
  return out;
}

/*
 * Temporary passwords: 4 groups of 4 from an alphabet with no look-alikes
 * (no 0/O, 1/l/I), so one read over the phone or pasted into a chat survives.
 * 20 characters over 31 symbols is ~99 bits — far past what a sign-in endpoint
 * with a hashed comparison could ever be brute-forced for.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateTemporaryPassword(random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/*
 * One list of people from two sources.
 *
 * AUTH_USERS wins on identity — an address listed there is an env account,
 * with the env's active flag and the admin rules that come with it — but its
 * PASSWORD comes from its os_users row when one exists. That is how an Owner
 * changes their password from the Account screen instead of editing a hash
 * in Railway; the env hash is what signs them in only until they do. If the
 * table is unreachable the env hash still works, so nobody is locked out by
 * a database outage. Grants come from the table for everyone (a row wins over
 * the env fallback), which is what 0003 already established.
 */
export interface MergedUser extends StoredUser {
  /** Where the sign-in record lives. Env users cannot be edited from the screen. */
  source: "env" | "db";
  name: string | null;
  mustChangePassword: boolean;
}

export function mergeUsers(
  envUsers: StoredUser[],
  dbUsers: Map<string, UserRow>,
  grants: Map<string, ToolId[]> | null,
): MergedUser[] {
  const out: MergedUser[] = [];
  const seen = new Set<string>();
  for (const u of envUsers) {
    seen.add(u.email);
    const row = grants?.get(u.email);
    const own = dbUsers.get(u.email);
    out.push({
      ...u,
      grants: row ?? u.grants,
      source: "env",
      name: own?.name ?? null,
      mustChangePassword: false,
      ...(own ? { passwordHash: own.passwordHash, tokenVersion: own.tokenVersion } : {}),
    });
  }
  for (const [email, row] of dbUsers) {
    if (seen.has(email)) continue;
    out.push({
      email,
      passwordHash: row.passwordHash,
      tokenVersion: row.tokenVersion,
      // An invited person has exactly the tools their row grants — no
      // bootstrap fail-open here, that exists only to keep the env admin in.
      grants: grants?.get(email) ?? [],
      isActive: row.isActive,
      source: "db",
      name: row.name,
      mustChangePassword: row.mustChangePassword,
    });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}
