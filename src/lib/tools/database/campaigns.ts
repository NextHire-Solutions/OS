/*
 * A client's campaigns, as the Database view lists them. Pure, so it is tested
 * without a database (campaigns.test.ts).
 *
 * Three sources, because no single one is complete:
 *
 *   bison_campaigns        every EmailBison campaign, linked by orch_client_id
 *                          (migration 0122) — including ones with no leads yet
 *   the leads themselves   the ONLY record of Instantly campaigns; there is no
 *                          instantly_campaigns table
 *   orch_clients.bison_campaign_id   the single id onboarding stored before
 *                          campaigns were synced
 */

export interface DbCampaign {
  id: string;
  name: string;
  provider: "EmailBison" | "Instantly";
  status: string | null;
  /**
   * Whether any of this campaign's leads have reached the Database. False is
   * the sync's fetch-failure path (45 of 257 campaigns on 28 Sep): the counts
   * beside it are then short, not zero. Null when the counts are unavailable.
   */
  leadsSynced: boolean | null;
}

/** Pure: one client's campaign list, EmailBison's own records first, no duplicates. */
export function mergeCampaigns(
  bison: { id: string; name: string; status: string | null }[],
  fromLeads: { id: string; name: string; provider: string }[],
  legacyBisonId: string | null,
  statsKnown: boolean,
): DbCampaign[] {
  const withLeads = new Set(fromLeads.map((c) => `${c.provider === "Instantly" ? "Instantly" : "EmailBison"}:${c.id}`));
  const synced = (key: string) => (statsKnown ? withLeads.has(key) : null);
  const out: DbCampaign[] = [];
  const seen = new Set<string>();
  const add = (c: Omit<DbCampaign, "leadsSynced">) => {
    const key = `${c.provider}:${c.id}`;
    if (!c.id || seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, leadsSynced: synced(key) });
  };
  for (const b of bison) add({ id: b.id, name: b.name, provider: "EmailBison", status: b.status });
  for (const c of fromLeads) {
    add({ id: c.id, name: c.name, provider: c.provider === "Instantly" ? "Instantly" : "EmailBison", status: null });
  }
  // The single id the onboarding flow stored before campaigns were synced.
  if (legacyBisonId) add({ id: legacyBisonId, name: "", provider: "EmailBison", status: null });
  return out;
}

