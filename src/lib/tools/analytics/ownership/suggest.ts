/*
 * WHICH CLIENT THE DATABASE SAYS A CAMPAIGN BELONGS TO — for Analytics.
 *
 * §2 ("connect their campaigns") and §14.12 ("centralized campaign
 * relationships"): Analytics attributes a campaign by its NAME. The Database
 * records the owner of each campaign against its client row
 * (bison_campaigns.orch_client_id, and each Instantly lead's client_id), and
 * the master record links that row to the Analytics client. Put together, the
 * Database's answer can be offered in Analytics.
 *
 * OFFERED, NOT WRITTEN. Both the OS and the standalone Analytics cron rerun the
 * name matcher over every automatic row, so an automatic write would be undone
 * within the hour. A person accepting the suggestion writes a manual pin, which
 * both matchers leave alone. Measured 28 Sep: the two agree on 264 campaigns,
 * the Database can place 11 that name matching cannot, and they disagree on 1.
 *
 * Pure; tested in suggest.test.ts.
 */

export interface DatabaseCampaigns {
  /** Database client id → its campaigns, as os_client_campaign_stats() returns them. */
  byClient: Map<string, { id: string; provider: string }[]>;
  /** EmailBison campaign number → Database client id (bison_campaigns.orch_client_id). */
  bisonOwner: Map<string, string>;
}

export type Platform = "emailbison" | "instantly";

/**
 * Campaign key → the Analytics client the Database places it with. A campaign
 * the Database files under two clients is left out: guessing is how a client's
 * numbers silently move to someone else.
 */
export function ownersFromDatabase(
  db: DatabaseCampaigns,
  analyticsIdFor: (databaseClientId: string) => string | null,
): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  const note = (key: string, dbClient: string) => {
    const an = analyticsIdFor(dbClient);
    if (!an) return;
    const s = owners.get(key) ?? new Set<string>();
    s.add(an);
    owners.set(key, s);
  };
  for (const [num, dbClient] of db.bisonOwner) note(keyOf("emailbison", num), dbClient);
  for (const [dbClient, list] of db.byClient) {
    for (const c of list) note(keyOf(c.provider === "Instantly" ? "instantly" : "emailbison", c.id), dbClient);
  }
  const out = new Map<string, string>();
  for (const [k, s] of owners) if (s.size === 1) out.set(k, [...s][0]);
  return out;
}

export const keyOf = (platform: Platform, campaignId: string | number) => `${platform}:${String(campaignId).trim()}`;

export interface Mapping {
  campaignId: string;
  platform: Platform;
  clientId: string | null;
  matchMethod: string | null;
  excluded: boolean;
}

export interface Disagreement {
  campaignId: string;
  platform: Platform;
  currentClientId: string;
  databaseClientId: string;
}

/**
 * Automatic matches the Database contradicts. Manual pins are a person's
 * decision and are not second-guessed; excluded campaigns are settled.
 */
export function disagreements(mappings: Mapping[], owners: Map<string, string>): Disagreement[] {
  const out: Disagreement[] = [];
  for (const m of mappings) {
    if (m.excluded || !m.clientId || m.matchMethod === "manual") continue;
    const want = owners.get(keyOf(m.platform, m.campaignId));
    if (want && want !== m.clientId) {
      out.push({ campaignId: m.campaignId, platform: m.platform, currentClientId: m.clientId, databaseClientId: want });
    }
  }
  return out;
}
