/** One person on Team access, as the rest of the OS sees them. */
export interface TeamMember {
  email: string;
  name: string;
  active: boolean;
  admin: boolean;
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

/** The clients a person is Account Manager for: the name on the record is theirs. */
export function isManagedBy(accountManager: string | null | undefined, member: Pick<TeamMember, "name" | "email">): boolean {
  if (!accountManager) return false;
  const k = norm(accountManager);
  return k === norm(member.name) || k === member.email;
}
