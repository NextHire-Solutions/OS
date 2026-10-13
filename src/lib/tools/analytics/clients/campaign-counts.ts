/*
 * How many campaigns each client has, on the Campaign Management → Clients tab.
 *
 * 13 Oct: "Instantly campaigns still showing though we have no more campaigns
 * on Instantly." Every client row read "21 … 12 on Instantly" because the count
 * was a count of MAPPINGS — one row per campaign ever matched to the client —
 * and a mapping outlives its campaign. All 333 Instantly campaigns were
 * archived by 1 Oct; their 333 mappings were still being counted, as were the
 * mappings of campaigns deleted in EmailBison.
 *
 * A campaign that is gone upstream is not one of the client's campaigns: it is
 * not in the Campaigns list, cannot be opened, and cannot be re-assigned. So
 * only mappings whose campaign is still LIVE are counted — EmailBison's not
 * deleted, Instantly's not archived — which is the same set the Campaigns list
 * shows for that client.
 *
 * (`sent`, beside it, deliberately still covers gone campaigns: those emails
 * really were sent. That sum is built separately in the route.)
 */

export interface CampaignMapping {
  campaign_id: string | number;
  client_id: string | null;
  excluded: boolean;
  match_method?: string | null;
}

export interface ClientCampaignCount {
  total: number;
  /** Pinned by hand rather than matched by name. */
  manual: number;
  /** Of the total, how many are Instantly's. */
  instantly: number;
}

export function clientCampaignCounts(input: {
  emailbison: readonly CampaignMapping[];
  instantly: readonly CampaignMapping[];
  /** EmailBison campaigns that still exist (not deleted). */
  liveEmailbison: Iterable<string | number>;
  /** Instantly campaigns that still exist (not archived). */
  liveInstantly: Iterable<string | number>;
}): Map<string, ClientCampaignCount> {
  const counts = new Map<string, ClientCampaignCount>();
  const tally = (rows: readonly CampaignMapping[], live: Iterable<string | number>, instantly: boolean) => {
    const alive = new Set([...live].map(String));
    for (const m of rows) {
      if (!m.client_id || m.excluded) continue;
      if (!alive.has(String(m.campaign_id))) continue;
      const c = counts.get(m.client_id) ?? { total: 0, manual: 0, instantly: 0 };
      c.total++;
      if (m.match_method === "manual") c.manual++;
      if (instantly) c.instantly++;
      counts.set(m.client_id, c);
    }
  };
  tally(input.emailbison, input.liveEmailbison, false);
  tally(input.instantly, input.liveInstantly, true);
  return counts;
}
