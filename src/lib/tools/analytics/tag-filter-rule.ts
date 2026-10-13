/*
 * The Tag filter on Campaign Analytics (13 Oct: "Add a filter by Tag next to
 * campaign, clients, platform").
 *
 * A tag is an EmailBison campaign tag — `campaigns.tags`, a jsonb array of tag
 * objects, synced from EmailBison. The filter is therefore a CAMPAIGN filter in
 * other words: "every campaign carrying any of these tags". It is resolved to
 * campaign ids once, here, and every analytics endpoint then filters by
 * campaign exactly as it already does — no SQL function gained a parameter.
 *
 * The rules:
 *
 *   · several tags are ALTERNATIVES (a campaign with either tag counts), the
 *     same as several campaigns or several clients in the other pickers;
 *   · tags combine WITH a campaign selection: both chosen means the chosen
 *     campaigns that also carry a chosen tag;
 *   · a tag selection that matches no campaign shows NOTHING — never
 *     everything. `p_campaign_ids: null` means "no restriction" to the SQL, so
 *     an empty list cannot be handed on; NO_CAMPAIGN is, and matches no row;
 *   · Instantly's tags are not synced (they are a separate resource there), so
 *     no Instantly campaign carries a tag and a tag filter takes Instantly out
 *     of scope — said on screen, the way a campaign filter already is.
 *
 * Pure, so the rule is tested without a database.
 */

/** A campaign id no campaign has. Positive ids only upstream, so this matches nothing. */
export const NO_CAMPAIGN = -1;

export interface TaggedCampaign {
  id: number;
  /** `campaigns.tags` as stored: [{ id, name, … }, …], or anything at all. */
  tags: unknown;
}

const keyOf = (tag: string) => tag.trim().toLowerCase();

/** The tag names on one campaign. Anything malformed is no tags, never a throw. */
export function tagNames(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const name = typeof t === "string" ? t : t && typeof t === "object" ? (t as { name?: unknown }).name : null;
    if (typeof name === "string" && name.trim()) out.push(name.trim());
  }
  return out;
}

export interface TagOption {
  value: string;
  label: string;
  /** How many campaigns carry it. */
  hint: string;
}

/** Every tag in use, most campaigns first, for the picker. */
export function tagOptions(campaigns: readonly TaggedCampaign[]): TagOption[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const c of campaigns) {
    // One campaign counts once per tag even if EmailBison lists the tag twice.
    for (const k of new Set(tagNames(c.tags).map(keyOf))) {
      const name = tagNames(c.tags).find((n) => keyOf(n) === k)!;
      const hit = count.get(k);
      if (hit) hit.n += 1;
      else count.set(k, { name, n: 1 });
    }
  }
  return [...count.values()]
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map(({ name, n }) => ({ value: name, label: name, hint: `${n} campaign${n === 1 ? "" : "s"}` }));
}

/** The campaigns carrying ANY of the tags, whatever the tag's case. */
export function campaignIdsWithTags(campaigns: readonly TaggedCampaign[], tags: readonly string[]): number[] {
  const wanted = new Set(tags.map(keyOf).filter(Boolean));
  if (!wanted.size) return [];
  return campaigns.filter((c) => tagNames(c.tags).some((n) => wanted.has(keyOf(n)))).map((c) => c.id);
}

interface CampaignSelection {
  tags: string[];
  campaignIds: string[];
  emailbisonCampaignIds: number[];
  instantlyCampaignIds: string[];
}

/*
 * The filters with the tag selection folded into the campaign selection.
 * Untouched — the same object — when no tag is chosen.
 */
export function narrowByTags<F extends CampaignSelection>(filters: F, tagged: readonly number[]): F {
  if (!filters.tags.length) return filters;
  const taggedSet = new Set(tagged);
  /*
   * A selection of only Instantly campaigns plus a tag is still "nothing": no
   * Instantly campaign carries a tag. Only an EmailBison selection narrows.
   */
  const anyCampaignChosen = filters.campaignIds.length > 0;
  const kept = anyCampaignChosen
    ? filters.emailbisonCampaignIds.filter((id) => taggedSet.has(id))
    : [...taggedSet];
  const ids = kept.length ? kept : [NO_CAMPAIGN];
  return { ...filters, campaignIds: ids.map(String), emailbisonCampaignIds: ids, instantlyCampaignIds: [] };
}
