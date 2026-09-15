/*
 * Where users and their tool grants come from.
 *
 * Deliberately an interface with two implementations. The env-backed one ships
 * today with nothing to provision; the Postgres one lands later and brings the
 * admin UI. Everything above this file — sign-in, refresh, the proxy, all four
 * apps — is written against `GrantStore` and does not change when we swap.
 *
 * The apps never call this. They read grants out of the signed token, which is
 * what keeps a permission check to one HMAC instead of a database round-trip.
 * This is consulted only when a token is issued or refreshed.
 */

// Relative, not the "@/" alias, so `node --test` can run this file's tests
// without a bundler resolving path mappings.
import { ALL_TOOLS, type ToolId } from "../bs-auth.ts";
// The "@/" alias resolves in the app but not under node --test. The store's own
// tests never construct DbGrantStore (they cover EnvGrantStore and the pure
// parsers), so this app-only import is dead weight there, not a break.
import { osTable } from "../clients/os-db.ts";
import { indexGrantRows, coerceStoredTools } from "./grant-table.ts";
import { indexUserRows, mergeUsers, type MergedUser, type UserRow } from "./user-table.ts";
import { isAdmin } from "./admin.ts";

/*
 * An admin (ADMIN_EMAILS) holds every tool, always.
 *
 * Their standing comes from the environment, not from a grants row, and it is
 * the one thing Team access must never be able to take away — an owner who
 * switched off their own Master Inbox by mistake would have no screen left to
 * switch it back on from. So grants are forced here, at the store, where
 * sign-in, refresh and the admin screen all read from.
 */
function withAdminGrants<T extends { email: string; grants: ToolId[] }>(u: T): T {
  return isAdmin(u.email) ? { ...u, grants: [...ALL_TOOLS] } : u;
}

export interface StoredUser {
  email: string;
  /** sha256 hex of the password. Same scheme the app already uses. */
  passwordHash: string;
  /** Bumped to invalidate every live token for this person. */
  tokenVersion: number;
  grants: ToolId[];
  isActive: boolean;
  /** Where the sign-in record lives. Undefined means env (the original store). */
  source?: "env" | "db";
  /** An invited person who has not yet replaced their temporary password. */
  mustChangePassword?: boolean;
}

export interface GrantStore {
  /** Case-insensitive. Returns null for unknown or deactivated users. */
  findByEmail(email: string): Promise<StoredUser | null>;
  /** Everyone, for the admin screen and diagnostics. */
  listUsers(): Promise<StoredUser[]>;
  /** How this store is configured, for /api/diagnostics. Never includes secrets. */
  describe(): { kind: string; userCount: number; governed: boolean };
}

// --- env-backed --------------------------------------------------------------

/**
 * Reads users from AUTH_USERS and grants from BS_GRANTS.
 *
 *   AUTH_USERS = "sam@x.com:<sha256hex>, nicole@x.com:<sha256hex>"
 *   BS_GRANTS  = "sam@x.com:inbox,clients,analytics,search
 *                 nicole@x.com:inbox,clients"
 *
 * ---------------------------------------------------------------------------
 * THE BOOTSTRAP RULE, AND WHY IT IS WHAT IT IS
 *
 * When BS_GRANTS is set, it is authoritative: an operator listed in AUTH_USERS
 * but absent from BS_GRANTS gets NO tools. Fail closed — adding someone must be
 * a deliberate act, not a side effect of existing.
 *
 * When BS_GRANTS is entirely unset, every AUTH_USERS operator gets every tool.
 * This is a fail-open and it is chosen on purpose: without it, deploying this
 * change would instantly lock the existing admin out of their own dashboard
 * with no way back in. AUTH_USERS is itself an allow-list that only an operator
 * with Railway access can edit, so the blast radius is "people who could
 * already sign in keep what they already had".
 *
 * `describe().governed` reports which mode is active, and the diagnostics route
 * surfaces it, so "we never actually set BS_GRANTS" cannot go unnoticed.
 */
export class EnvGrantStore implements GrantStore {
  private users: Map<string, StoredUser>;
  private governed: boolean;

  constructor(authUsers: string | undefined, bsGrants: string | undefined) {
    const grants = parseGrants(bsGrants);
    this.governed = grants.size > 0;
    this.users = new Map();

    for (const [email, passwordHash] of parseAuthUsers(authUsers)) {
      this.users.set(email, {
        email,
        passwordHash,
        tokenVersion: 1,
        grants: this.governed ? (grants.get(email) ?? []) : [...ALL_TOOLS],
        isActive: true,
      });
    }
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const user = this.users.get(email.trim().toLowerCase());
    return user && user.isActive ? user : null;
  }

  async listUsers(): Promise<StoredUser[]> {
    return [...this.users.values()];
  }

  describe() {
    return { kind: "env", userCount: this.users.size, governed: this.governed };
  }
}

// --- table-backed ------------------------------------------------------------

/**
 * Who may sign in comes from AUTH_USERS; what they may open comes from the
 * os_tool_grants table.
 *
 * The table is authoritative for anyone who has a row, exactly as BS_GRANTS is
 * authoritative when set. Someone in AUTH_USERS with no row falls through to
 * the same env logic as before, so turning the table on does not silently strip
 * access from people it has never heard of.
 *
 * The read is guarded: if the table does not exist yet (the migration has not
 * been run) or the query fails, every lookup falls back to the env store rather
 * than failing sign-in. Access changes still land within the 30-minute refresh,
 * because refresh re-reads this store — the whole reason the admin UI can save
 * without a redeploy.
 */
export class DbGrantStore implements GrantStore {
  private env: EnvGrantStore;

  constructor(authUsers: string | undefined, bsGrants: string | undefined) {
    this.env = new EnvGrantStore(authUsers, bsGrants);
  }

  private async table(): Promise<Map<string, ToolId[]> | null> {
    try {
      const { data, error } = await osTable("os_tool_grants").select("email, tools");
      if (error) return null;
      return indexGrantRows((data ?? []) as Array<{ email?: unknown; tools?: unknown }>);
    } catch {
      // Table absent, or no service-role credentials in this environment.
      return null;
    }
  }

  /*
   * Invited people (0004). Null when the table is absent, which the callers
   * treat as "nobody invited" — the env allow-list keeps working on its own.
   */
  private async users(): Promise<Map<string, UserRow> | null> {
    try {
      const { data, error } = await osTable("os_users").select("*");
      if (error) return null;
      return indexUserRows((data ?? []) as Array<Record<string, unknown>>);
    } catch {
      return null;
    }
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const key = email.trim().toLowerCase();
    const base = await this.env.findByEmail(key);
    const rows = await this.table();
    if (base) {
      const row = rows?.get(key);
      // A grants row wins; no row keeps whatever the env store decided
      // (BS_GRANTS or the bootstrap fail-open). A users row supplies the
      // password an env account set from the Account screen.
      const own = (await this.users())?.get(key);
      return withAdminGrants({
        ...base,
        grants: row ?? base.grants,
        source: "env" as const,
        mustChangePassword: false,
        ...(own ? { passwordHash: own.passwordHash, tokenVersion: own.tokenVersion } : {}),
      });
    }
    // Not in AUTH_USERS: only an active invited person can sign in, and only
    // with the tools their grants row names — no fail-open for them.
    const invited = (await this.users())?.get(key);
    if (!invited || !invited.isActive) return null;
    // Invited people get exactly their grants row — never the admin rule.
    return ({
      email: invited.email,
      passwordHash: invited.passwordHash,
      tokenVersion: invited.tokenVersion,
      grants: rows?.get(key) ?? [],
      isActive: true,
      source: "db" as const,
      mustChangePassword: invited.mustChangePassword,
    });
  }

  async listUsers(): Promise<StoredUser[]> {
    return this.listMerged();
  }

  /** Everyone, with where each record lives — for the Team access screen. */
  async listMerged(): Promise<MergedUser[]> {
    const base = await this.env.listUsers();
    const [rows, users] = await Promise.all([this.table(), this.users()]);
    return mergeUsers(base, users ?? new Map(), rows).map((u) => (u.source === "env" ? withAdminGrants(u) : u));
  }

  /*
   * Which tables actually answer. `describe()` is synchronous and cannot know;
   * this is what the admin API uses to report `writable` and `canInvite`
   * truthfully. Reporting writable while the table was missing made the screen
   * say "switches save as you click them" when every click would have failed.
   */
  async probeTables(): Promise<{ grants: boolean; users: boolean }> {
    const [g, u] = await Promise.all([
      osTable("os_tool_grants").select("email").limit(1).then((r) => !r.error, () => false),
      osTable("os_users").select("email").limit(1).then((r) => !r.error, () => false),
    ]);
    return { grants: g, users: u };
  }

  describe() {
    return { kind: "db+env", userCount: this.env.describe().userCount, governed: true };
  }
}

/* ---------------------------------------------------------- invited people */

/** Insert an invited person. Fails if the address already has a row. */
export async function createUser(input: {
  email: string;
  name: string | null;
  passwordHash: string;
  by: string;
}): Promise<void> {
  const { error } = await osTable("os_users").insert({
    email: input.email.trim().toLowerCase(),
    name: input.name,
    password_hash: input.passwordHash,
    must_change_password: true,
    is_active: true,
    token_version: 1,
    created_by: input.by,
  });
  if (error) throw new Error(error.message);
}

/**
 * Deactivate or reactivate. Bumps token_version so a deactivated person's
 * live session cannot refresh — they are out within the 30-minute window.
 */
export async function setUserActive(email: string, active: boolean): Promise<void> {
  const key = email.trim().toLowerCase();
  const { data, error } = await osTable("os_users").select("token_version").eq("email", key).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`${key} is not an invited user.`);
  const ver = typeof (data as { token_version?: unknown }).token_version === "number"
    ? ((data as { token_version: number }).token_version)
    : 1;
  const { error: upd } = await osTable("os_users")
    .update({ is_active: active, token_version: ver + 1, updated_at: new Date().toISOString() })
    .eq("email", key);
  if (upd) throw new Error(upd.message);
}

/** Replace the password (a fresh temporary one) and invalidate live sessions. */
export async function resetUserPassword(email: string, passwordHash: string): Promise<void> {
  const key = email.trim().toLowerCase();
  const { data, error } = await osTable("os_users").select("token_version").eq("email", key).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`${key} is not an invited user.`);
  const ver = typeof (data as { token_version?: unknown }).token_version === "number"
    ? ((data as { token_version: number }).token_version)
    : 1;
  const { error: upd } = await osTable("os_users")
    .update({ password_hash: passwordHash, must_change_password: true, token_version: ver + 1, updated_at: new Date().toISOString() })
    .eq("email", key);
  if (upd) throw new Error(upd.message);
}

/**
 * Write one person's tool access. Absent list clears their row (back to the
 * env fallback); an empty list stores an explicit lockout.
 */
export async function writeGrant(email: string, tools: ToolId[], by?: string): Promise<void> {
  const clean = coerceStoredTools(tools);
  await osTable("os_tool_grants").upsert(
    { email: email.trim().toLowerCase(), tools: clean, updated_at: new Date().toISOString(), updated_by: by ?? null },
    { onConflict: "email" },
  );
}

/** `email:sha256hex` pairs, separated by newlines or commas. */
function parseAuthUsers(raw: string | undefined): Map<string, string> {
  const users = new Map<string, string>();
  if (!raw) return users;

  for (const entry of raw.split(/[\n,]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // lastIndexOf, not indexOf: an email cannot contain ':' but a future hash
    // format might, and splitting on the last one keeps the email intact.
    const sep = trimmed.lastIndexOf(":");
    if (sep === -1) continue;
    const email = trimmed.slice(0, sep).trim().toLowerCase();
    const hash = trimmed.slice(sep + 1).trim().toLowerCase();
    if (email && hash) users.set(email, hash);
  }
  return users;
}

/**
 * `email:tool,tool` entries, one per line.
 *
 * Newline-separated rather than comma-separated because the values themselves
 * are comma lists. Unknown tool names are dropped, so a typo grants nothing
 * instead of throwing at boot and taking sign-in down with it.
 */
function parseGrants(raw: string | undefined): Map<string, ToolId[]> {
  const out = new Map<string, ToolId[]>();
  if (!raw) return out;

  for (const line of raw.split(/[\n;]+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;

    const email = trimmed.slice(0, sep).trim().toLowerCase();
    const claimed = trimmed
      .slice(sep + 1)
      .split(",")
      .map((t) => t.trim().toLowerCase());

    if (!email) continue;
    out.set(email, ALL_TOOLS.filter((t) => claimed.includes(t)));
  }
  return out;
}

// --- resolution --------------------------------------------------------------

let cached: GrantStore | null = null;

/**
 * The active store.
 *
 * Memoised per process: parsing env on every sign-in would be wasteful, and a
 * change to either variable requires a redeploy anyway, which resets this.
 */
export function grantStore(): GrantStore {
  if (!cached) {
    // The table-backed store degrades to env on its own when the table or the
    // service-role key is missing, so it is always safe to prefer it.
    cached = new DbGrantStore(process.env.AUTH_USERS, process.env.BS_GRANTS);
  }
  return cached;
}

/** Tests only. */
export function __resetGrantStore() {
  cached = null;
}

/**
 * A person replacing their own password. Clears the must-change flag and bumps
 * token_version so every OTHER session of theirs ends; the caller re-mints the
 * current one with the returned version.
 */
export async function changeUserPassword(email: string, passwordHash: string, by?: string): Promise<{ tokenVersion: number }> {
  const key = email.trim().toLowerCase();
  const { data, error } = await osTable("os_users").select("token_version").eq("email", key).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    // An AUTH_USERS account setting its first OS password: create its row.
    // token_version 2, so the session that made the change is re-minted and
    // any other session of theirs (minted at the env's 1) ends.
    const { error: ins } = await osTable("os_users").insert({
      email: key, name: null, password_hash: passwordHash, must_change_password: false,
      is_active: true, token_version: 2, created_by: by ?? key,
    });
    if (ins) throw new Error(ins.message);
    return { tokenVersion: 2 };
  }
  const ver = typeof (data as { token_version?: unknown }).token_version === "number"
    ? ((data as { token_version: number }).token_version)
    : 1;
  const { error: upd } = await osTable("os_users")
    .update({ password_hash: passwordHash, must_change_password: false, token_version: ver + 1, updated_at: new Date().toISOString() })
    .eq("email", key);
  if (upd) throw new Error(upd.message);
  return { tokenVersion: ver + 1 };
}
