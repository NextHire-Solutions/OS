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

export interface StoredUser {
  email: string;
  /** sha256 hex of the password. Same scheme the app already uses. */
  passwordHash: string;
  /** Bumped to invalidate every live token for this person. */
  tokenVersion: number;
  grants: ToolId[];
  isActive: boolean;
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
    cached = new EnvGrantStore(process.env.AUTH_USERS, process.env.BS_GRANTS);
  }
  return cached;
}

/** Tests only. */
export function __resetGrantStore() {
  cached = null;
}
