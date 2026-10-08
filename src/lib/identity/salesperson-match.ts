/*
 * SALESPEOPLE — who sold a client, as the Salespeople list on Team access
 * holds them (os_salespeople, migration 0020).
 *
 * "Just for our records" (the client, 30 Sep): a salesperson does not need a
 * sign-in. The client record's Salesperson is chosen from this list, and
 * Commissions pays the client's Salesperson at their own rates. A salesperson
 * whose email matches a Team access sign-in sees their own commissions.
 */
import type { Rates } from "../commissions/schedule.ts";

export interface Salesperson {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  rates: Rates;
  /**
   * When the Salesperson role was switched off (Eastern day), for an inactive
   * record. Payouts up to that day still pay them; later payouts do not.
   * Null on an inactive record with no known date: they earn nothing.
   */
  offSince?: string | null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Tidy a typed name: one space between words, none around. */
export const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");

/** Which salesperson a name means. Case and spacing do not matter; exact names only. */
export function matchSalesperson(
  input: string,
  people: Salesperson[],
): { kind: "found"; person: Salesperson } | { kind: "none" } | { kind: "ambiguous"; name: string } {
  const key = norm(input);
  if (!key) return { kind: "none" };
  const hits = people.filter((p) => norm(p.name) === key);
  if (hits.length === 1) return { kind: "found", person: hits[0] };
  if (hits.length > 1) return { kind: "ambiguous", name: hits[0].name };
  return { kind: "none" };
}

/** Is this client's Salesperson this person? */
export function isSoldBy(salesperson: string | null | undefined, person: Pick<Salesperson, "name">): boolean {
  return !!salesperson && norm(salesperson) === norm(person.name);
}

/** Problems with a name or email before it is saved; empty when fine. */
export function salespersonProblems(input: { name?: string; email?: string | null }): string[] {
  const errors: string[] = [];
  if (input.name !== undefined) {
    const n = cleanName(input.name);
    if (!n) errors.push("A salesperson needs a name.");
    else if (n.length > 80) errors.push("A name can be at most 80 characters.");
    else if (n.includes(",")) errors.push("A name cannot contain a comma.");
  }
  if (input.email !== undefined && input.email !== null && input.email.trim()) {
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(input.email.trim())) errors.push("That email address does not look right.");
  }
  return errors;
}
