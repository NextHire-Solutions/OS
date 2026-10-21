/*
 * Admin-only pages opened to a person by name — not a role, not a Team access
 * switch, and nothing else of the admin's (21 Oct, the user: "provide access to
 * Reply Agent to Amy on the OS"). The same pattern as the Billing tab and the
 * portal preview: a person is added here, deliberately, on the user's word.
 *
 * The page check (nav.ts canSeePage, via viewer-roles) and the page's own
 * routes (auth/require-reply-agent.ts) both read this list.
 */

export const NAMED_PAGES: Readonly<Record<string, readonly string[]>> = {
  "reply-agent": ["amy@brokerstaffer.com"],
};

const norm = (email: string | null | undefined) => (email ?? "").trim().toLowerCase();

/** The admin-only pages this address holds by name. */
export function namedPagesFor(email: string | null | undefined): string[] {
  const e = norm(email);
  if (!e) return [];
  return Object.entries(NAMED_PAGES)
    .filter(([, people]) => people.includes(e))
    .map(([page]) => page);
}

export function holdsPage(email: string | null | undefined, page: string): boolean {
  const e = norm(email);
  return !!e && (NAMED_PAGES[page] ?? []).includes(e);
}
