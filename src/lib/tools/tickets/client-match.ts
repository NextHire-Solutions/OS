import { emailDomain, OWN_EMAIL_DOMAINS } from "../../clients/billing-model.ts";
import { normEmail } from "./gmail-message.ts";

/*
 * TICKETS — is this sender one of our clients, and which? Pure: the client list is passed in.
 *
 * THE RULE (the user, 20 Nov: "make sure we only see emails that came from client's email addresses. no other
 * emails should be shown here, this is very important"): an email is a client's ONLY when its From address is one
 * we hold for a client — on the client's record (contacts 1-3, more contacts, point of contact) or on one of its
 * portals' sign-in or team lists (the same addresses billing matches Stripe customers by: billing-emails.ts).
 * Nothing else: no company-domain guessing (someone new at the client's company is added to the client's record
 * first), never To/Cc (a newsletter Cc'ing a client is not the client writing), never our own addresses, never an
 * internal record (Demo Portal, BrokerStaffer).
 *
 * An address on two clients goes to the live one (active, paused, onboarding) before a churned one, then by name;
 * the other is named on the ticket so a person can switch it.
 */

export interface MatchClient {
  id: string;
  name: string;
  status: string | null;
  internal: boolean;
  emails: readonly string[];
}

export interface ClientMatch {
  clientId: string;
  method: "address";
  /** Other clients the same address is on, for a person to switch to. */
  alsoOn: string[];
}

export interface ClientIndex {
  byEmail: Map<string, string[]>;
  clients: Map<string, MatchClient>;
}

const LIVE = new Set(["active", "paused", "onboarding"]);

const isOwn = (d: string) => OWN_EMAIL_DOMAINS.some((o) => d === o || d.endsWith(`.${o}`));

export function buildClientIndex(clients: readonly MatchClient[]): ClientIndex {
  const byEmail = new Map<string, string[]>();
  const map = new Map<string, MatchClient>();
  for (const c of clients) {
    if (c.internal) continue;
    map.set(c.id, c);
    for (const raw of c.emails) {
      const e = normEmail(raw);
      if (!e || isOwn(emailDomain(e))) continue;
      const ids = byEmail.get(e) ?? [];
      if (!ids.includes(c.id)) byEmail.set(e, [...ids, c.id]);
    }
  }
  return { byEmail, clients: map };
}

function rank(index: ClientIndex, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const ca = index.clients.get(a), cb = index.clients.get(b);
    const la = LIVE.has(String(ca?.status ?? "").toLowerCase()) ? 0 : 1;
    const lb = LIVE.has(String(cb?.status ?? "").toLowerCase()) ? 0 : 1;
    return la - lb || String(ca?.name ?? "").localeCompare(String(cb?.name ?? ""));
  });
}

/** The client whose address this is, or null. Exact addresses only. */
export function matchSender(index: ClientIndex, email: string | null | undefined): ClientMatch | null {
  const e = normEmail(email);
  if (!e || isOwn(emailDomain(e))) return null;
  const exact = index.byEmail.get(e);
  if (!exact?.length) return null;
  const [clientId, ...alsoOn] = rank(index, exact);
  return { clientId, method: "address", alsoOn };
}

/** Our side of a conversation: our own domains, a connected mailbox, or a teammate's personal address. */
export function isTeamAddress(email: string | null | undefined, team: ReadonlySet<string>): boolean {
  const e = normEmail(email);
  if (!e) return false;
  return isOwn(emailDomain(e)) || team.has(e);
}

/*
 * The Gmail search that finds a mailbox's client mail for the first fill: every client address in full, in
 * chunks so no single query grows long. A prefilter only — every hit's From is matched again. 2026 quota: a
 * messages.get costs 20 units, so asking Gmail for client mail only is what keeps a first fill short.
 */
export function backfillQueries(index: ClientIndex, days: number, chunk = 24): string[] {
  const list = [...index.byEmail.keys()].sort();
  const out: string[] = [];
  for (let i = 0; i < list.length; i += chunk) {
    out.push(`from:(${list.slice(i, i + chunk).join(" OR ")}) newer_than:${Math.max(1, Math.round(days))}d -in:chats -in:drafts`);
  }
  return out;
}
