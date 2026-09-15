/*
 * The DB-app handshake's matching rule, on its own.
 *
 * Their `bison_campaigns.bison_campaign_id` column holds the campaign UUID
 * while we store Bison's numeric id — so every identifier the row carries
 * (column, raw.id, raw.uuid) counts, and the two apps' formats can never miss
 * each other. Ported from the tool's `lib/db-sync.ts`.
 */

export const LAUNCHED_STATUSES = ["campaign_launched", "live", "paused"]; // paused = deliberately stopped, never relaunch

export function flippedCampaignIds(rows: { bison_campaign_id?: unknown; raw?: unknown }[]): Set<string> {
  const flipped = new Set<string>();
  for (const r of rows) {
    if (r.bison_campaign_id != null) flipped.add(String(r.bison_campaign_id));
    const raw = r.raw as { id?: unknown; uuid?: unknown } | null | undefined;
    if (raw?.id != null) flipped.add(String(raw.id));
    if (raw?.uuid) flipped.add(String(raw.uuid));
  }
  return flipped;
}
