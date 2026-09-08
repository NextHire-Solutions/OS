// Shared client → Instantly campaign matching logic. Used by both the seed
// script (server-side, full campaign list) and the Add/Edit Client modal
// (client-side, list pulled at page load). Keep the rules identical so a
// client name added through the UI yields the same links as a re-seed would.

interface NamedCampaign {
  id: string;
  name: string;
}

// Manual overrides for clients whose Corofy name doesn't appear verbatim in
// any Instantly campaign name. The value is a list of campaign-name prefixes
// (normalized); any campaign whose normalized name starts with one of these
// is linked to the client.
export const MANUAL_LINKS: Record<string, string[]> = {
  'Howe Realty Group': ['howe realty'],
};

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,()]/g, '')
    .replace(/&/g, 'and')
    .replace(/[-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-name match: a campaign matches a client if its normalized name
 * CONTAINS the normalized client name as a substring. Plus any prefix
 * override registered in MANUAL_LINKS.
 */
export function autoMatchCampaigns<T extends NamedCampaign>(
  clientName: string,
  campaigns: readonly T[]
): T[] {
  const cnorm = normalizeForMatch(clientName);
  if (!cnorm) return [];
  const overrides = (MANUAL_LINKS[clientName] ?? []).map(normalizeForMatch);
  return campaigns.filter((c) => {
    const cn = normalizeForMatch(c.name);
    if (cn.includes(cnorm)) return true;
    return overrides.some((prefix) => cn.startsWith(prefix));
  });
}

export function autoMatchCampaignIds(
  clientName: string,
  campaigns: readonly NamedCampaign[]
): string[] {
  return autoMatchCampaigns(clientName, campaigns).map((c) => c.id);
}
