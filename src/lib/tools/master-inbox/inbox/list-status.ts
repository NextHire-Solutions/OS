import { normalizeClientName, type ClientStatus } from "./lists-shared";

/*
 * The status dot beside each client in the inbox's client list — from the
 * MASTER RECORD.
 *
 * This read Client Health's two booleans (hidden / client_paused), which is how
 * status was stored before the four-status lifecycle. So an onboarding client
 * showed as active, and whenever Client Health disagreed with the master (as
 * Discover PHX did on 28 Sep) the inbox showed the disagreeing answer. The
 * standalone Master Inbox reads the OS's status feed; the OS reads its own
 * record.
 *
 * Keyed by every name a list could carry: the client's name, each alias, and
 * the name of each Master Inbox row linked to it — which is how a SECOND
 * portal ("Properties & Estates Florida") finds its client. A key two clients
 * both claim is dropped rather than guessed. Onboarding clients get no dot,
 * the same as the feed (the dot set is active / paused / churned).
 *
 * Pure; tested in list-status.test.ts.
 */
export interface MasterForStatus {
  name: string;
  aliases: string[];
  status: "onboarding" | ClientStatus;
  /** Names of the Master Inbox rows that belong to this client. */
  inboxNames: string[];
}

export function statusByListName(masters: MasterForStatus[]): {
  byName: Record<string, ClientStatus>;
  counts: Record<ClientStatus, number>;
} {
  const claims = new Map<string, Set<ClientStatus>>();
  const counts: Record<ClientStatus, number> = { active: 0, paused: 0, churned: 0 };
  for (const m of masters) {
    if (m.status === "onboarding") continue;
    counts[m.status] += 1;
    for (const n of [m.name, ...m.aliases, ...m.inboxNames]) {
      const key = normalizeClientName(n ?? "");
      if (!key) continue;
      const set = claims.get(key) ?? new Set<ClientStatus>();
      set.add(m.status);
      claims.set(key, set);
    }
  }
  const byName: Record<string, ClientStatus> = {};
  for (const [key, set] of claims) if (set.size === 1) byName[key] = [...set][0];
  return { byName, counts };
}
