import { NextResponse } from "next/server";
import {
  getAnalyticsSupabase as getSupabase,
  analyticsTeamId,
  fetchAllRows,
} from "@/lib/tools/analytics/supabase";
import { cachedGet } from "@/lib/tools/analytics/cached-get";
import {
  emailbisonInbox,
  instantlyInbox,
  latestStamp,
  sendersWithSends,
  type InboxesResponse,
  type InboxRow,
  type InstantlyAccountRecord,
  type InstantlyAccountStats,
  type SenderEmailRecord,
} from "@/lib/tools/analytics/inboxes.ts";

/*
 * Every sending inbox, for the Inboxes page (13 Oct).
 *
 * The whole list in one answer — about 1,700 EmailBison inboxes plus the
 * Instantly accounts — because the page sorts and filters it in the browser,
 * on every column at once. That makes this the route where PostgREST's cap
 * matters most: a select stops at 1,000 rows and says nothing, so EVERY read
 * below is paged (fetchAllRows, or p_limit/p_offset on the one RPC). An
 * unpaged read here would be a page headed "1,000 inboxes" that looked
 * finished.
 *
 * Read-only, and nothing here calls EmailBison or Instantly: it is what the
 * three-hourly sync already stored. What the sync does not store is returned
 * as null and explained in `notes`, never estimated.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => analyticsTeamId();

const PAGE = 1000;

/**
 * The statuses in which a campaign can still send — the same three Pause is
 * offered for (campaigns/status.ts). A campaign resumed a moment ago is
 * `queued`, and counting only `active` would drop its inboxes until it moved.
 */
const SENDING_STATUSES = ["active", "queued", "launching"];

const NOTE_WARMUP =
  "Warmup 3d / 7d: not available yet. The sync stores only whether warmup is switched on for an inbox, " +
  "not its score. EmailBison supplies the score from GET /api/warmup/sender-emails (warmup_score for a " +
  "start_date–end_date range), so it needs a sync job reading that for 3 and 7 days and two columns to keep " +
  "the result in.";

/*
 * THE DEFINITION, and why it is this one. Nothing in the database records
 * which inboxes are attached to which campaign — that list lives only in
 * EmailBison (campaigns/[id]/inboxes reads it live, 45 pages for one large
 * campaign, so it cannot be asked for every campaign on a page load). What IS
 * stored is every email sent, with the inbox that sent it. So "assigned" here
 * is "has sent for a campaign that can still send", which is wrong in exactly
 * two ways, both said in the note.
 *
 * (campaign_lead_sends rather than campaign_leads: that table keeps only the
 * inbox that sent to each lead most recently, and has no index on the inbox.
 * The send history held 97.6% of lifetime sends when 060 measured it, so it
 * is very nearly complete but not complete by definition.)
 */
const NOTE_ASSIGNED =
  "Assigned: Yes when the inbox has sent at least one email for a campaign that is active now (active, " +
  "queued or launching, and not deleted), read from the synced send history. It shows No for an inbox " +
  "attached to a campaign that has not sent from it yet, and Yes for one since removed from a campaign it " +
  "sent for — EmailBison's own campaign-to-inbox list is not synced.";

const NOTE_REPLIED =
  "Replied (all time) counts people who replied, the same figure Infrastructure's reply rate uses.";

const NOTE_INSTANTLY =
  "Instantly inboxes: Sent, Replied and Bounced are the totals of what has been synced, because Instantly " +
  "reports no lifetime counter per inbox. Status, Warmup and Assigned are not known for them and show a " +
  "dash, and so does Vendor unless the inbox carries a p. tag.";

const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : ((error as { message?: string } | null)?.message ?? "the database did not answer");

/**
 * Which EmailBison inboxes have sent for a campaign that can still send.
 * See NOTE_ASSIGNED for what that does and does not mean.
 */
async function sendingInboxes(teamId: number, inboxIds: number[]): Promise<Set<number>> {
  const sb = getSupabase();

  const live = await fetchAllRows<{ id: number }>((from, to) =>
    sb
      .from("campaigns")
      .select("id")
      .eq("team_id", teamId)
      .is("deleted_at", null)
      .in("status", SENDING_STATUSES)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const campaignIds = live.map((c) => c.id);
  if (!campaignIds.length || !inboxIds.length) return new Set();

  /*
   * Ids only, newest first, a group of inboxes at a time — see
   * sendersWithSends for why that settles in a few reads. The campaign filter
   * has to be in the query: filtered here instead, an inbox whose newest
   * sends were all for a paused campaign would fill every page and never be
   * settled.
   */
  return sendersWithSends(inboxIds, async (ids, limit) => {
    // No team filter: both lists of ids are already this team's.
    const { data, error } = await sb
      .from("campaign_lead_sends")
      .select("sender_email_id")
      .in("sender_email_id", ids)
      .in("campaign_id", campaignIds)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ sender_email_id: number | string | null }>).map((r) =>
      r.sender_email_id === null ? null : Number(r.sender_email_id),
    );
  }, { limit: PAGE });
}

/** The Instantly accounts, with the sending totals Infrastructure shows for them. */
async function instantlyInboxes(teamId: number): Promise<{ rows: InboxRow[]; asOf: string | null }> {
  const sb = getSupabase();

  const accounts = await fetchAllRows<InstantlyAccountRecord>((from, to) =>
    sb
      .from("instantly_accounts")
      .select("email, first_name, last_name, provider_code, daily_limit, tags, synced_at")
      .eq("team_id", teamId)
      .is("archived_at", null)
      .order("email", { ascending: true })
      .range(from, to),
  );
  if (!accounts.length) return { rows: [], asOf: null };

  /*
   * The same function Infrastructure reads, so the two pages cannot disagree
   * about an inbox. Paged through its own arguments: an RPC's rows are capped
   * at 1,000 exactly as a select's are.
   */
  const stats = new Map<string, InstantlyAccountStats>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await sb.rpc("analytics_instantly_account_rows", {
      p_team_id: teamId,
      p_search: null,
      p_min_sent: 0,
      p_limit: PAGE,
      p_offset: offset,
    });
    if (error) throw new Error(error.message);
    const page = (data ?? []) as InstantlyAccountStats[];
    for (const row of page) stats.set(row.email, row);
    if (page.length < PAGE) break;
  }

  return {
    rows: accounts.map((a) => instantlyInbox(a, stats.get(a.email))),
    asOf: latestStamp(accounts.map((a) => a.synced_at)),
  };
}

async function load(): Promise<Response> {
  const teamId = TEAM_ID();

  let senders: SenderEmailRecord[];
  try {
    // Inside the try, so a missing database setting is reported by name
    // rather than as a bare 500.
    const sb = getSupabase();
    senders = await fetchAllRows<SenderEmailRecord>((from, to) =>
      sb
        .from("sender_emails")
        // One literal, not a joined string: the client reads the column list from its type.
        .select("id, email, name, provider, status, vendor, tags, daily_limit, warmup_enabled, lifetime_sent, lifetime_bounced, unique_replied, synced_at")
        .eq("team_id", teamId)
        // Deleted upstream. Kept for the sends they made, shown nowhere (060).
        .is("archived_at", null)
        // A fixed order, or two pages can overlap and a row fall between them.
        .order("id", { ascending: true })
        .range(from, to),
    );
  } catch (error) {
    // The list is the page itself; without it there is nothing to show.
    console.error("[api/inboxes]", error);
    return NextResponse.json({ error: messageOf(error) }, { status: 500 });
  }

  /*
   * The two extras fail on their own. A send history that cannot be read
   * leaves "Assigned" unknown, and an Instantly read that fails leaves those
   * rows out — each says so in a note. Neither is a reason to hide 1,700
   * inboxes that loaded.
   */
  const [assigned, instantly] = await Promise.allSettled([
    sendingInboxes(teamId, senders.map((s) => s.id)),
    instantlyInboxes(teamId),
  ]);

  const notes = [NOTE_ASSIGNED, NOTE_WARMUP, NOTE_REPLIED];

  if (assigned.status === "rejected") {
    console.error("[api/inboxes] assigned", assigned.reason);
    notes[0] =
      "Assigned could not be worked out just now, so it shows a dash for every inbox: the send history " +
      `could not be read (${messageOf(assigned.reason)}).`;
  }
  const sending = assigned.status === "fulfilled" ? assigned.value : null;

  const rows: InboxRow[] = senders.map((s) => emailbisonInbox(s, sending));
  const synced = [latestStamp(senders.map((s) => s.synced_at))];

  if (instantly.status === "rejected") {
    console.error("[api/inboxes] instantly", instantly.reason);
    notes.push(
      `Instantly inboxes could not be loaded just now and are missing from this list (${messageOf(instantly.reason)}).`,
    );
  } else if (instantly.value.rows.length) {
    rows.push(...instantly.value.rows);
    synced.push(instantly.value.asOf);
    notes.push(NOTE_INSTANTLY);
  }

  // A to Z across both platforms: the order the page falls back to when no
  // column is sorted.
  rows.sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()));

  /*
   * The OLDER of the two platforms' sync times. One line has to speak for the
   * whole list, and it must not call the list fresher than its stalest half.
   */
  const stamps = synced.filter((s): s is string => Boolean(s));
  const asOf = stamps.length
    ? stamps.reduce((oldest, s) => (Date.parse(s) < Date.parse(oldest) ? s : oldest))
    : null;

  const body: InboxesResponse = { rows, total: rows.length, asOf, notes };
  return NextResponse.json(body);
}

// Identical questions inside a minute are answered from memory — see cached-get.ts.
export const GET = cachedGet(load);
