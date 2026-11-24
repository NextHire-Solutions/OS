/*
 * PROSPECTS — WHICH CAMPAIGN AN AREA'S NEW PROSPECTS GO TO, WHEN NOBODY PICKED ONE (24 Nov 2026).
 *
 * Gabriel added an agent to Jeff Cook's Prospects; nothing happened, because a client with several MLSs needed a campaign
 * picked by hand for each MLS on its Campaigns tab, and none was. The team (via the user): link areas to campaigns
 * automatically; a link set by hand stays as it is and is never changed by this.
 *
 * THE RULE, per agent (an agent belongs to one or more of the client's MLSs):
 *  1. The candidates: the client's own campaigns that are sending or paused (never a draft, a finished or an archived one).
 *  2. A campaign takes an MLS's agents when at least MIN_SHARE of its leads (and MIN_LEADS of them) are that MLS's
 *     agents — read from the leads it already has (Analytics' campaign_leads + each lead's "mls affiliation", the custom
 *     field every lead is made with). Campaign names don't say the MLS (2 of 54 do), and one MLS can feed two areas'
 *     campaigns, so the leads decide, not the name.
 *  3. Several do: a sending one before a paused one; then the one with the most leads in the agent's own city (two
 *     campaigns of one MLS split by area, e.g. The Rafeh Group's two SOCAL ones); then the larger share (in 5-point
 *     steps); then the newest — so of two near-identical paused copies (Jeff Cook's Columbia and "6 + Columbia",
 *     85% and 86% CMLS on 24 Nov) the newer one.
 *  4. None for any of the agent's MLSs: nothing is guessed — the agent waits and the bell asks (as before).
 * Measured on Jeff Cook, 24 Nov: CHSMLS → Charleston (49 of 53 leads), CCAR → Myrtle Beach (48 of 49), CANOPY →
 * Charlotte–Triad (61 of 61), CMLS → Columbia (paused, 173 of 200), GGAR → Greenville (paused, 173 of 200).
 *
 * Pure: the profiles are read by the caller (campaign-profiles.ts).
 */

export interface CampaignProfile {
  id: string;
  name: string;
  status: string;
  /** Leads read (a recent sample, at most PROFILE_SAMPLE). */
  sampled: number;
  /** Leads per MLS code ("FMLS | GAMLS" counts for both). */
  mls: Record<string, number>;
  /** Leads per city (office city or top producing city, normalised by normCity). */
  cities: Record<string, number>;
}

export interface AutoLink {
  id: string;
  name: string;
  status: string;
  /** The agent's MLS it was linked by. */
  code: string;
  /** In words, for the row's detail and the Campaigns tab: why this campaign. */
  why: string;
}

export const MIN_SHARE = 0.2;
export const MIN_LEADS = 3;
export const PROFILE_SAMPLE = 200;

const SENDING = new Set(["active", "queued", "launching"]);
export const linkable = (status: string | null | undefined): boolean => {
  const s = String(status ?? "").trim().toLowerCase();
  return SENDING.has(s) || s === "paused";
};
const sending = (status: string) => SENDING.has(String(status).trim().toLowerCase());

/** "Columbia, SC" → "columbia"; blanks → "". */
export function normCity(v: string | null | undefined): string {
  return String(v ?? "").split(",")[0].replace(/\s+/g, " ").trim().toLowerCase();
}

/** "FMLS | GAMLS" → ["FMLS", "GAMLS"]. */
export function mlsCodesOf(v: string | null | undefined): string[] {
  return String(v ?? "").split(/[|,;/]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
}

const num = (id: string) => (/^\d+$/.test(id) ? Number(id) : 0);

/** The campaign this agent's prospects go to when nobody picked one for its MLS, or null (it waits). */
export function autoLinkFor(agent: { codes: readonly string[]; cities: readonly (string | null | undefined)[] }, profiles: readonly CampaignProfile[]): AutoLink | null {
  const cities = [...new Set(agent.cities.map(normCity).filter(Boolean))];
  for (const raw of agent.codes) {
    const code = raw.trim().toUpperCase();
    const fits = profiles
      .filter((p) => linkable(p.status) && p.sampled > 0)
      .map((p) => {
        const n = p.mls[code] ?? 0;
        return { p, n, share: n / p.sampled, inCity: cities.reduce((t, c) => t + (p.cities[c] ?? 0), 0) };
      })
      .filter((x) => x.n >= MIN_LEADS && x.share >= MIN_SHARE);
    if (!fits.length) continue;
    // Shares in 5-point steps: a renewal's near-copy (85% vs 86%) is a tie, and the newer campaign takes it.
    const step = (share: number) => Math.round(share * 20);
    fits.sort((a, b) =>
      Number(sending(b.p.status)) - Number(sending(a.p.status)) ||
      b.inCity - a.inCity ||
      step(b.share) - step(a.share) ||
      num(b.p.id) - num(a.p.id));
    const best = fits[0];
    const pct = Math.round(best.share * 100);
    const byCity = fits.length > 1 && best.inCity > 0 && fits.filter((f) => sending(f.p.status) === sending(best.p.status)).length > 1;
    const why = `${pct}% of its leads are ${code} agents${byCity ? `, and it has the most from ${cities.map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase())).join(" / ")}` : ""}${sending(best.p.status) ? "" : " (paused: they'll be emailed once it's resumed)"}`;
    return { id: best.p.id, name: best.p.name, status: best.p.status, code, why };
  }
  return null;
}

/** For the Campaigns tab: the campaign an MLS's agents go to now (city aside), or null. */
export function autoLinkForMls(code: string, profiles: readonly CampaignProfile[]): AutoLink | null {
  return autoLinkFor({ codes: [code], cities: [] }, profiles);
}
