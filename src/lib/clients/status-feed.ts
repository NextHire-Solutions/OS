import { listOsClients } from "./os-clients";

/*
 * The platform client-status feed, served from `os_clients`.
 *
 * This is the Layer 2 move in the architecture spec: client information is
 * mastered in the OS, and every tool reads it from here instead of keeping
 * its own answer. The shape is the one MasterInbox already consumes from
 * Client Health — { total, counts, clients: [{id,name,status}] } — so the
 * cutover is a change of CLIENT_STATUS_URL, not a change of code in
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
 *
 * ---------------------------------------------------------------------------
 * ONE CLIENT, MANY PORTALS — why every alias is emitted too
 *
 * MasterInbox keeps ONE ROW PER PORTAL and matches the feed on the normalised
 * client name. A client working several markets therefore has several rows,
 * none of them named exactly like the master client:
 *
 *     master client            MasterInbox rows (portals)
 *     Properties & Estates  ->  "Properties & Estates Boston"
 *                               "Properties & Estates Florida"
 *     SERHANT. PA           ->  "SERHANT. PA"
 *                               "SERHANT. PA 15M+"
 *
 * Emitting only the master name meant "Properties & Estates" matched NEITHER
 * of its portals, and SERHANT's "15M+" portal matched nothing either. Those
 * portals sat outside status control entirely: pausing or churning the client
 * left them open, which is the exact failure this feed exists to prevent.
 *
 * os_clients already records the other spellings as `aliases`, and the OS
 * reconciler already treats them as identity rather than decoration. So the
 * feed now emits ONE ENTRY PER KNOWN NAME — the master name and every alias —
 * each carrying the master's status and the master's id. One status change
 * then drives every portal the client has, and MasterInbox needs no change.
 *
 * `total` and `counts` still describe DISTINCT CLIENTS, not entries. That is
 * deliberate and is the point of the model: a client with two portals is ONE
 * client and every tool must count it once. So `clients.length` can exceed
 * `total`, and `entries` reports that length for anyone checking.
 *
 * ---------------------------------------------------------------------------
 * AMBIGUITY IS DROPPED, NEVER GUESSED
 *
 * Two clients whose names normalise identically would make a portal's status a
 * coin flip, so such an entry is dropped and reported in `omitted`. A PRIMARY
 * name always beats an alias — a real client's own name must never be
 * overridden by another client's nickname. This mirrors the campaign matcher,
 * which also refuses to guess on a tie rather than file a campaign under the
 * wrong client.
 */

export type FeedStatus = "active" | "paused" | "churned";

/** How a consumer came to match this entry — informational, for debugging. */
export type FeedVia = "name" | "alias";

export interface StatusFeedEntry {
  /** The MASTER client's id. Alias entries repeat it: one client, many names. */
  id: string;
  name: string;
  status: FeedStatus;
  via: FeedVia;
}

export interface StatusFeed {
  /** DISTINCT CLIENTS emitted — not entries. A client with two portals is 1. */
  total: number;
  counts: Record<FeedStatus, number>;
  /** One per known name: the master name plus every alias. */
  clients: StatusFeedEntry[];
  /** `clients.length`. Differs from `total` when a client has several names. */
  entries: number;
  /**
   * Clients and names deliberately left out, so "why is this portal not
   * following the OS?" has an answer in the response itself rather than in a
   * log somewhere.
   */
  omitted: { name: string; status: string; reason: string }[];
}

const EMITTED: Record<string, FeedStatus> = {
  active: "active",
  paused: "paused",
  churned: "churned",
};

/** Exactly MasterInbox's `normalizeClientName`, so collisions are the ones it sees. */
const norm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface StatusFeedRow {
  id: string;
  name: string;
  status: string;
  /** Other spellings this client is known by — each one a portal that must follow. */
  aliases?: string[] | null;
}

export function buildStatusFeed(rows: StatusFeedRow[]): StatusFeed {
  const clients: StatusFeedEntry[] = [];
  const omitted: StatusFeed["omitted"] = [];
  const distinct = new Set<string>();

  /* ---- which rows are emittable at all ---- */
  const eligible: { row: StatusFeedRow; name: string; status: FeedStatus }[] = [];
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
    eligible.push({ row, name, status });
  }

  /* ---- pass 1: master names. These always win a collision. ---- */
  const taken = new Map<string, StatusFeedEntry>();
  for (const { row, name, status } of eligible) {
    const key = norm(name);
    const clash = taken.get(key);
    if (clash) {
      // Two real clients cannot share a normalised name without making some
      // portal's status arbitrary. Neither is guessed at.
      omitted.push({
        name,
        status: row.status,
        reason: `name collides with "${clash.name}" once normalised — dropped rather than guessed`,
      });
      continue;
    }
    const entry: StatusFeedEntry = { id: row.id, name, status, via: "name" };
    taken.set(key, entry);
    clients.push(entry);
    distinct.add(row.id);
  }

  /* ---- pass 2: aliases — each one another portal of the same client ---- */
  for (const { row, name, status } of eligible) {
    const primary = norm(name);
    for (const raw of row.aliases ?? []) {
      const alias = (raw ?? "").trim();
      if (!alias) continue;
      const key = norm(alias);
      if (!key || key === primary) continue; // same name once normalised
      const clash = taken.get(key);
      if (clash) {
        if (clash.id === row.id) continue; // the same client under two spellings
        omitted.push({
          name: alias,
          status: row.status,
          reason:
            clash.via === "name"
              ? `alias of "${name}" collides with the client "${clash.name}" — the real name wins`
              : `alias of "${name}" collides with an alias of another client — dropped rather than guessed`,
        });
        continue;
      }
      const entry: StatusFeedEntry = { id: row.id, name: alias, status, via: "alias" };
      taken.set(key, entry);
      clients.push(entry);
    }
  }

  /*
   * Counted over DISTINCT CLIENTS, not entries — a client with two portals is
   * one client. Taken from the primary-name entries, which are exactly one per
   * emitted client.
   */
  const counts: Record<FeedStatus, number> = { active: 0, paused: 0, churned: 0 };
  for (const c of clients) if (c.via === "name") counts[c.status] += 1;

  return { total: distinct.size, counts, clients, entries: clients.length, omitted };
}

export async function clientStatusFeed(): Promise<StatusFeed> {
  const rows = await listOsClients();
  return buildStatusFeed(
    rows.map((c) => ({ id: c.id, name: c.name, status: c.status, aliases: c.aliases })),
  );
}
