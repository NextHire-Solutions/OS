/*
 * The person the new portal shows as "you" — whoever is signed in (29 Oct: Eddy, signed in to BrokerStaffer's portal,
 * was shown its client record's contact, Ryan). Their name on the portal's team, else the name on its sign-in list (a
 * client), else their OS account's (staff), else the address itself. Pure: page.tsx reads the rows.
 */
export function teamName(email: string, team: ReadonlyArray<{ name: string | null; email: string | null }>): string | null {
  const key = email.trim().toLowerCase();
  if (!key) return null;
  return team.find((m) => (m.email ?? "").trim().toLowerCase() === key)?.name?.trim() || null;
}

/** A first name to greet with — none for an address (someone with no name anywhere is greeted without one). */
export function firstName(name: string | null | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.includes("@") ? "" : first;
}

export function personName(email: string, sources: { team?: string | null; listed?: string | null; account?: string | null }): string {
  return sources.team?.trim() || sources.listed?.trim() || sources.account?.trim() || email.trim().toLowerCase();
}
