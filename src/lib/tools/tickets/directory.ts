import "server-only";

import { clientMatchEmails } from "@/lib/clients/billing-emails";
import { osTable } from "@/lib/clients/os-db";
import { isKnownNonClient } from "@/lib/clients/roster";
import { listTeamMembers } from "@/lib/identity/team-directory";
import { ttlCache } from "@/lib/tools/master-inbox/cache/ttl";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import { buildClientIndex, type ClientIndex, type MatchClient } from "./client-match";

/*
 * TICKETS — who the clients are (with every address we know them by) and who the team is.
 *
 * Client addresses: the record's people (contacts 1-3, more contacts, point of contact) and, on portals the OS
 * places with a client (ownerOf), the sign-in lists and the portal's own team list (client_team_members) —
 * the same sources and the same placing rule billing uses to match Stripe customers (billing-emails.ts).
 * Read every page or fail: half a list could make a client's address look like nobody's.
 */

export interface ClientDirectory { index: ClientIndex; clients: MatchClient[] }

const loadDirectory = ttlCache(async (): Promise<ClientDirectory> => {
  const mi = getMasterInboxSupabase();
  const [rec, portals, signIns, teams] = await Promise.all([
    osTable("os_clients").select("id, name, status, aliases, mi_client_id, contact_email, contact2_email, contact3_email, more_contacts, poc_email"),
    fetchAllRows<Record<string, unknown>>(({ from, to }) => mi.from("clients").select("id, name").order("id", { ascending: true }).range(from, to)),
    fetchAllRows<Record<string, unknown>>(({ from, to }) => mi.from("os_portal_logins").select("id, portal_id, email").is("removed_at", null).order("id", { ascending: true }).range(from, to)),
    fetchAllRows<Record<string, unknown>>(({ from, to }) => mi.from("client_team_members").select("id, client_id, email, active").order("id", { ascending: true }).range(from, to)),
  ]);
  if (rec.error) throw new Error(`os_clients: ${rec.error.message}`);
  const rows = (rec.data ?? []) as Array<Record<string, unknown>>;
  const emails = clientMatchEmails(
    rows.map((r) => ({
      id: String(r.id), name: String(r.name ?? ""), aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : [],
      miClientId: typeof r.mi_client_id === "string" && r.mi_client_id ? r.mi_client_id : null,
      contactEmail: r.contact_email, contact2Email: r.contact2_email, contact3Email: r.contact3_email, moreContacts: r.more_contacts, pocEmail: r.poc_email,
    })),
    portals.map((p) => ({ id: String(p.id), name: String(p.name ?? "") })),
    [
      ...signIns.map((s) => ({ portalId: String(s.portal_id), email: String(s.email ?? "") })),
      ...teams.filter((t) => t.active !== false).map((t) => ({ portalId: String(t.client_id), email: String(t.email ?? "") })),
    ],
  );
  const clients: MatchClient[] = rows.map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    status: typeof r.status === "string" ? r.status : null,
    internal: isKnownNonClient(String(r.name ?? "")),
    emails: emails.get(String(r.id)) ?? [],
  }));
  return { index: buildClientIndex(clients), clients };
}, { ttlMs: 5 * 60_000, key: () => "tickets-directory", shared: "tickets-directory" });

export const clientDirectory = () => loadDirectory();
export const forgetClientDirectory = () => loadDirectory.invalidate();

export interface TeamDirectory {
  /** Every teammate's address and every connected mailbox, lower-case. */
  set: Set<string>;
  /** Address → name ("Amy Anderes"). */
  names: Map<string, string>;
}

export async function teamDirectory(mailboxes: ReadonlyArray<{ email: string; name: string | null }> = []): Promise<TeamDirectory> {
  const members = await listTeamMembers().catch(() => []);
  const set = new Set<string>();
  const names = new Map<string, string>();
  for (const m of members) {
    set.add(m.email.toLowerCase());
    names.set(m.email.toLowerCase(), m.name);
  }
  for (const mb of mailboxes) {
    set.add(mb.email.toLowerCase());
    if (!names.has(mb.email.toLowerCase()) && mb.name) names.set(mb.email.toLowerCase(), mb.name);
  }
  return { set, names };
}
