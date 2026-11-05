/*
 * WHO RECEIVES A PORTAL'S INTERESTED AGENTS, for the assistant (5 Nov; the user: "it should tell the contacts name with
 * emails like who will get the interested replies. but make sure client can see only their data only").
 *
 * The answer is what really happens: planRecipients, the hand-off's own choice of people, from the one record that
 * belongs to the one portal (chat.ts, rosterRowForPortal: the record the Introduce button and the hand-off use for it).
 * Pure. Only chat.ts reads this: the relay's rules stay out of the browser's bundle (chat-tools.ts reaches it).
 */

import { INTRO_ROW_COLUMNS, introClientFromRow, introContacts, placeKey } from "@/lib/tools/master-inbox/inbox/intro-macro";
import { normEmail, planRecipients } from "@/lib/tools/master-inbox/relay/rules";
import { brokerageFromJson, directHandoffReason } from "@/lib/tools/master-inbox/relay/settings";

import type { InterestedContacts } from "./chat-tools.ts";

export const NOBODY_FOR_MARKET = "no contact with an email is on file for this market";

export function interestedContacts(row: Record<string, unknown> | null, portalName: string): InterestedContacts {
  if (!row) return { people: [] };
  const client = introClientFromRow(row, portalName);
  const relay = brokerageFromJson(row.relay_settings);
  // A brokerage's own address counts only while the hand-off replaces the introduction: otherwise the Introduce button copies the contacts in.
  const settings = directHandoffReason(row, portalName) ? relay : { ...relay, recipients: "intro_contacts" as const };
  const plan = (campaign: string | null) => planRecipients(settings, client, campaign, []);

  const { recipients, via } = plan(null);
  if (via === "address") return { people: recipients.map((r) => ({ name: r.name, email: r.email, markets: [] })) };

  const everyone = introContacts(client);
  const people = recipients.map((r) => {
    // The same address can be on the record twice: with no market on either row it covers everything.
    const rows = everyone.filter((c) => normEmail(c.email) === r.email);
    const markets = rows.some((c) => !c.territories?.length) ? [] : [...new Set(rows.flatMap((c) => c.territories ?? []))];
    return { name: r.name, email: r.email, markets };
  });

  const places = new Map<string, string>();
  for (const c of everyone) for (const t of c.territories ?? []) if (!places.has(placeKey(t))) places.set(placeKey(t), t);
  if (!places.size) return { people };

  /*
   * Each market asked of the routing itself, never worked out here: "North Charleston" also goes to whoever covers
   * "Charleston", spelling and case don't split a market, and a person with no email receives nothing.
   */
  const named = (list: typeof recipients) => list.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email));
  const table = [...places.values()].map((m): [string, string[]] => {
    const got = named(plan(m).recipients);
    return [m, got.length ? got : [NOBODY_FOR_MARKET]];
  });
  return { people, whoGetsWhichMarket: Object.fromEntries([...table, ["any other market, or a campaign that names none", named(recipients)]]) };
}

const norm = (s: unknown) => (typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : "");

/*
 * The record really is this portal's: linked to it, or carrying its name. A campaign route alone isn't enough here: it is
 * checked only when it is written, and this answer gives names and emails to whoever signed in to the portal. Every real
 * portal passes (5 Nov: 59 linked, 2 routed and named). Anything else is refused and logged, never shown.
 */
function isThisPortalsRecord(row: Record<string, unknown>, portalId: string, portalName: string | null): boolean {
  if (row.mi_client_id === portalId) return true;
  const want = norm(portalName);
  const aliases = Array.isArray(row.aliases) ? row.aliases : [];
  return !!want && [row.name, ...aliases].some((n) => norm(n) === want);
}

/** Finds a portal's own record: rosterRowForPortal, passed in so this stays pure. */
type FindRecord = (portalId: string, portalName: string | null, columns: string) => Promise<{ row: Record<string, unknown> | null; error?: string; readFailed?: boolean }>;

/** The contacts of this one portal, and never a guess: a failed read says so, and two records with the portal's name are nobody (rosterRowForPortal). */
export async function contactsOfPortal(find: FindRecord, portalId: string, portalName: string | null): Promise<InterestedContacts> {
  const unavailable = { unavailable: "The contacts could not be read just now." };
  try {
    const { row, error, readFailed } = await find(portalId, portalName, `${INTRO_ROW_COLUMNS}, relay_settings, pipeline_entry, mi_client_id, aliases`);
    if (error || (!row && readFailed)) return unavailable;
    if (row && !isThisPortalsRecord(row, portalId, portalName)) {
      console.error(JSON.stringify({ at: "[crm-preview] chat contacts: the record found isn't this portal's", portal: portalId }));
      return unavailable;
    }
    return interestedContacts(row, portalName ?? "");
  } catch {
    return unavailable;
  }
}
