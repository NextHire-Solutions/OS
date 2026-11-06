import { moreContactsFrom } from "../tools/master-inbox/inbox/intro-macro.ts";

import { ownerOf } from "./delete-portal-rule.ts";

/*
 * THE ADDRESSES THAT MAY TIE A STRIPE CUSTOMER TO A CLIENT (6 Nov) — the input to billing-model.ts's email match.
 *
 * The user: after onboarding, the OS finds the client in Stripe "using email or anything". A client's people are on its
 * record (the three contacts, the extra contacts, the point of contact) and on its portals' sign-in lists — which
 * onboarding asks for, so a client onboarded today often has its sign-ins and nothing else. Measured on the 50 customers
 * tied by hand, each source picked the same client every time it picked one.
 *
 * A portal is the client's by the OS's own rule (delete-portal-rule.ts ownerOf: the record's portal, else a name or
 * alias that fits one client only). A portal that rule can't place is some business all the same: an address on its
 * list is on two businesses if a client has it too, so it is taken off every client (it matches no one). Pure: the rows
 * are passed in.
 */

export interface EmailSourceRow {
  id: string;
  name: string;
  aliases: string[];
  miClientId: string | null;
  contactEmail?: unknown;
  contact2Email?: unknown;
  contact3Email?: unknown;
  moreContacts?: unknown;
  pocEmail?: unknown;
}

const address = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Each client's addresses, lower-case and once each. Sign-ins removed from a list are not passed in. */
export function clientMatchEmails(
  rows: readonly EmailSourceRow[],
  portals: ReadonlyArray<{ id: string; name: string }>,
  signIns: ReadonlyArray<{ portalId: string; email: string }>,
): Map<string, string[]> {
  const out = new Map<string, Set<string>>(rows.map((r) => [r.id, new Set<string>()]));
  for (const r of rows) {
    for (const e of [r.contactEmail, r.contact2Email, r.contact3Email, r.pocEmail, ...moreContactsFrom(r.moreContacts).map((c) => c.email)]) {
      if (address(e)) out.get(r.id)!.add(address(e));
    }
  }
  const owners = rows.map((r) => ({ ...r, aliases: r.aliases ?? [] }));
  const portalOwner = new Map(portals.map((p) => [p.id, ownerOf(owners, p)?.id ?? null]));
  const unplaced = new Set<string>();
  for (const s of signIns) {
    if (!address(s.email)) continue;
    const owner = portalOwner.get(s.portalId);
    if (owner) out.get(owner)?.add(address(s.email));
    else unplaced.add(address(s.email));
  }
  return new Map([...out].map(([id, set]) => [id, [...set].filter((e) => !unplaced.has(e))]));
}
