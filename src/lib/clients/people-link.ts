/*
 * ONE SALESPERSON, ONE ACCOUNT MANAGER, ONE SENDER — per client, in one place.
 *
 * §5's worked example is "change the account manager once and every tool
 * updates". Two editors existed for these fields and neither told the other:
 *
 *   the OS's Edit dialog      → os_clients.salesperson / account_manager / sender_name (text)
 *   Onboarding's client page  → orch_clients.salesperson_id / account_manager_id (people ids)
 *                               and sender_name, which the campaign build writes
 *
 * §15's closing rule is that no field is independently editable in two places.
 * So each write now carries to the other side. On 28 Sep the two agreed on
 * every client (Salesperson on 2, the rest empty everywhere), so nothing
 * existing needed reconciling.
 *
 * The Database side stores a PERSON ID from orch_salespeople, the team list
 * managed under Onboarding → Settings. A name typed in Edit is matched to that
 * list — the same find-or-create the Onboarding page already does for a
 * salesperson — so the two editors cannot end up naming different people.
 *
 * Pure; tested in people-link.test.ts.
 */

export type PersonRole = "salesperson" | "account_manager";

export interface TeamPerson {
  id: string;
  name: string;
  role: string | null;
}

export type Resolution =
  | { kind: "clear" }
  | { kind: "found"; id: string; name: string }
  | { kind: "create"; name: string; role: PersonRole }
  | { kind: "ambiguous"; names: string[] };

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Which team member a typed name means. Same name, any case, whole name only —
 * "Ryan" does not become "Ryan Jagdeo". Someone holding the requested role is
 * preferred; two people with the same name in that role is refused rather than
 * guessed.
 */
export function resolvePerson(name: string | null | undefined, people: TeamPerson[], role: PersonRole): Resolution {
  const wanted = norm(name ?? "");
  if (!wanted) return { kind: "clear" };
  const same = people.filter((p) => norm(p.name) === wanted);
  const inRole = same.filter((p) => p.role === role);
  const pool = inRole.length ? inRole : same;
  if (pool.length === 1) return { kind: "found", id: pool[0].id, name: pool[0].name };
  if (pool.length > 1) return { kind: "ambiguous", names: pool.map((p) => p.name) };
  return { kind: "create", name: name!.trim().replace(/\s+/g, " "), role };
}
