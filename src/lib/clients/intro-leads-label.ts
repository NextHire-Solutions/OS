/*
 * The line under each person on a client's "Introduce to" (24 Nov 2026, the team: "a clear label under each contact
 * that shows which leads they get, for example 'Gets REBNY, Manhattan, Brooklyn leads' or 'Gets every lead'").
 * Douglas Elliman NYC had its wording set per campaign but no territories, so both contacts got every intro and nothing
 * on the page said so.
 *
 * It says what the Introduce button does (intro-macro.ts introContacts + routeIntro): only a person with a name AND a
 * role is introduced; with a territory, to leads from campaigns naming one of its places (and from campaigns naming
 * none, which go to everyone); without one, to every lead; with no email, named in the intro but not copied in.
 * No server imports: the client record renders it.
 */

export interface LeadsLabel {
  text: string;
  /** some: a territory · all: every lead · none: not introduced at all. */
  tone: "some" | "all" | "none";
  /** The longer explanation (hover). */
  title: string;
}

const clean = (xs: readonly (string | null | undefined)[] | null | undefined) => (xs ?? []).map((x) => (x ?? "").trim()).filter(Boolean);
const orList = (xs: string[]) => (xs.length <= 1 ? xs[0] ?? "" : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** Null for an empty slot (the page says "Add a person"). */
export function introLeadsLabel(p: { name?: string | null; role?: string | null; email?: string | null; territories?: readonly (string | null | undefined)[] | null }): LeadsLabel | null {
  if (!(p.name ?? "").trim()) return null;
  if (!(p.role ?? "").trim()) {
    return { text: "Gets no leads: add a role", tone: "none", title: "The Introduce button only introduces people with a name and a role." };
  }
  const places = clean(p.territories);
  const noEmail = !(p.email ?? "").trim();
  const suffix = noEmail ? " · not copied in: no email" : "";
  const emailNote = noEmail ? " Named in the introduction, but not copied in until an email is added." : "";
  if (places.length) {
    return {
      text: `Gets ${places.join(", ")} leads${suffix}`,
      tone: "some",
      title: `Leads from campaigns whose name includes ${orList(places)}, and from any campaign that names no territory (those go to everyone).${emailNote}`,
    };
  }
  return { text: `Gets every lead${suffix}`, tone: "all", title: `No territory, so introduced to every lead.${emailNote}` };
}
