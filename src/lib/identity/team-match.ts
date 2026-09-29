/** One person on Team access, as the rest of the OS sees them. */
export interface TeamMember {
  email: string;
  name: string;
  active: boolean;
  admin: boolean;
  /** Has the Account manager role on Team access (0021). */
  accountManager?: boolean;
}

/**
 * Who can be a client's Account Manager: active people with the Account
 * manager role. Before roles existed (0021 not run, nobody has one) it is
 * every active person, as it was.
 */
export function accountManagerPool(members: TeamMember[]): TeamMember[] {
  const active = members.filter((m) => m.active);
  const withRole = active.filter((m) => m.accountManager);
  return withRole.length ? withRole : active;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Which team member a name (or address) means. Case and spacing do not
 * matter; two members with the same name are refused rather than guessed.
 */
export function matchTeamMember(
  input: string,
  members: TeamMember[],
): { kind: "found"; member: TeamMember } | { kind: "none" } | { kind: "ambiguous"; name: string } {
  const key = norm(input);
  if (!key) return { kind: "none" };
  const byEmail = members.filter((m) => m.email === key);
  if (byEmail.length === 1) return { kind: "found", member: byEmail[0] };
  const byName = members.filter((m) => norm(m.name) === key);
  if (byName.length === 1) return { kind: "found", member: byName[0] };
  if (byName.length > 1) return { kind: "ambiguous", name: byName[0].name };
  return { kind: "none" };
}

/*
 * A client may have more than one Account Manager (the client's decision,
 * 30 Sep). The master record keeps them in its one text column, in order,
 * separated by ", " — "Amy, Eddy". Names on Team access cannot contain a
 * comma (a name with one is refused on save), so the split is exact.
 */
export const MANAGER_SEPARATOR = ", ";

/** The names in an Account Manager value, trimmed, blanks and repeats dropped. */
export function splitManagers(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const name = part.trim().replace(/\s+/g, " ");
    if (name && !out.some((n) => norm(n) === norm(name))) out.push(name);
  }
  return out;
}

export const joinManagers = (names: string[]): string | null =>
  names.length ? names.join(MANAGER_SEPARATOR) : null;

/** The clients a person is Account Manager for: their name is one of the record's. */
export function isManagedBy(accountManager: string | null | undefined, member: Pick<TeamMember, "name" | "email">): boolean {
  return splitManagers(accountManager).some((n) => {
    const k = norm(n);
    return k === norm(member.name) || k === member.email;
  });
}
