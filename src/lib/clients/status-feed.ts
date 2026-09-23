import { listOsClients } from "./os-clients";

/*
 * The platform client-status feed, served from `os_clients`.
 *
 * This is the Layer 2 move in the architecture spec: client information is
 * mastered in the OS, and every tool reads it from here instead of keeping
 * its own answer. The shape is byte-for-byte the one MasterInbox already
 * consumes from Client Health — { total, counts, clients: [{id,name,status}] }
 * — so the cutover is a change of CLIENT_STATUS_URL, not a change of code in
 * MasterInbox.
 *
 * TWO RULES, both of which exist to stop a live portal closing by accident.
 *
 * 1. Only active | paused | churned are ever emitted. MasterInbox treats
 *    anything that is not `active` as "portal off", so emitting a fourth word
 *    would silently close portals.
 *
 * 2. A client still being onboarded is OMITTED, not downgraded. Onboarding is
 *    not "not active" in the sense that matters here — it is "we have not
 *    decided yet", and a client can be mid-onboarding while their portal is
 *    deliberately already open for them to look at. MasterInbox never touches
 *    a client that is absent from the feed, so omitting leaves such a portal
 *    exactly as a person last set it. Downgrading would shut it.
 *
 * `prospect` is the pre-0012 spelling of `onboarding` and is treated the same
 * way, so this behaves correctly whether or not that migration has been run.
 */

export type FeedStatus = "active" | "paused" | "churned";

export interface StatusFeedEntry {
  id: string;
  name: string;
  status: FeedStatus;
}

export interface StatusFeed {
  total: number;
  counts: Record<FeedStatus, number>;
  clients: StatusFeedEntry[];
  /**
   * Clients deliberately left out, so "why is this portal not following the
   * OS?" has an answer in the response itself rather than in a log somewhere.
   */
  omitted: { name: string; status: string; reason: string }[];
}

const EMITTED: Record<string, FeedStatus> = {
  active: "active",
  paused: "paused",
  churned: "churned",
};

export function buildStatusFeed(
  rows: Array<{ id: string; name: string; status: string }>,
): StatusFeed {
  const clients: StatusFeedEntry[] = [];
  const omitted: StatusFeed["omitted"] = [];

  for (const row of rows) {
    const name = (row.name ?? "").trim();
    if (!name) {
      // A nameless row can never be matched by a consumer that matches on
      // name, and an empty name would match nothing anyway. Say so.
      omitted.push({ name: row.name ?? "", status: row.status, reason: "no name" });
      continue;
    }
    const status = EMITTED[row.status];
    if (!status) {
      omitted.push({
        name,
        status: row.status,
        reason:
          row.status === "onboarding" || row.status === "prospect"
            ? "still onboarding — left untouched on purpose"
            : "status is not one a consumer understands",
      });
      continue;
    }
    clients.push({ id: row.id, name, status });
  }

  const counts: Record<FeedStatus, number> = { active: 0, paused: 0, churned: 0 };
  for (const c of clients) counts[c.status] += 1;

  return { total: clients.length, counts, clients, omitted };
}

export async function clientStatusFeed(): Promise<StatusFeed> {
  const rows = await listOsClients();
  return buildStatusFeed(rows.map((c) => ({ id: c.id, name: c.name, status: c.status })));
}
