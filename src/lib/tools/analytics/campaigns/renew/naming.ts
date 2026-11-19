/*
 * DUPLICATE & RENEW — the names (BrokerStaffer spec, 19 Nov).
 *
 * The campaign being renewed keeps the original name ("LIV Indy Realty +
 * Indianapolis Metro + ZF NS4 (EST)"); when it is renewed it takes the next
 * number ("LIV Indy Realty 6 + …") and the new campaign takes the original
 * name. The number goes at the end of the name's first part, before the first
 * " + " (the whole name when there is no " + ").
 *
 * WHICH CAMPAIGNS COUNT AS EARLIER ROUNDS. A campaign is an earlier round when
 * taking ONE standalone number out of its name leaves exactly the campaign's
 * name (spaces and case aside). That reads the team's own history as written,
 * including the places it put the number somewhere else:
 *   "LIV Indy Realty 5 + Indianapolis Metro + ZF NS4 (EST)"   → round 5
 *   "C21 Results 1 - Elite Team + Atlanta + ZF NS1 (EST)"     → round 1 of "C21 Results - Elite Team + Atlanta + …"
 * and keeps different series apart: "… + ZF NS1 (EST)" is not a round of
 * "… + ZF NS4 (EST)", nor is "LIV Indy Realty New Target 2 + …".
 *
 * ANOTHER CAMPAIGN WITH EXACTLY THE SAME NAME (renewed by hand once, the old
 * one never numbered) does not stop it: it is named in the review window and
 * left as it is. Refusing would lock the button out of ten real campaigns.
 *
 * A CAMPAIGN THAT IS ITSELF AN EARLIER ROUND IS NOT RENEWED. If the campaign's
 * own first part ends in a number and that number is a round of a series that
 * exists (the unnumbered campaign, or other rounds), renewing it would give
 * "LIV Indy Realty 5 6 + …". A number that is part of the brand ("Century 21 +
 * …", with no such series) is left alone.
 *
 * Pure: no I/O, so every rule here is pinned by naming.test.ts.
 */

export interface NamedCampaign {
  id: number;
  name: string;
  status?: string | null;
}

export interface EarlierRound {
  id: number;
  name: string;
  status: string | null;
  round: number;
}

export type NamePlan =
  | {
      ok: true;
      /** The name the new campaign takes: the renewed campaign's own name, as it is. */
      newName: string;
      /** The renewed campaign's new name. */
      numberedName: string;
      round: number;
      /** The earlier rounds found, oldest number first. */
      earlier: EarlierRound[];
      /**
       * Other campaigns with exactly this name (the team renewed by hand once without numbering the old one —
       * 10 such pairs on 19 Nov, e.g. #1252 and #644). Left as they are; the review window names them.
       */
      sameName: Array<{ id: number; name: string; status: string | null }>;
    }
  | { ok: false; reason: string };

/** Spaces collapsed, ends trimmed, lower case: how two names are compared. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const SEPARATOR = /\s+\+\s+/;

/** The name's first part and everything from the first " + " on (separator included, as written). */
export function splitFirstPart(name: string): { head: string; rest: string } {
  const m = SEPARATOR.exec(name);
  if (!m) return { head: name, rest: "" };
  return { head: name.slice(0, m.index), rest: name.slice(m.index) };
}

/** The name with the round number at the end of its first part: "LIV Indy Realty 6 + …". */
export function withRound(name: string, round: number): string {
  const trimmed = name.trim();
  const { head, rest } = splitFirstPart(trimmed);
  return `${head.trimEnd()} ${round}${rest}`;
}

/**
 * The round a campaign is of `base`: its number when taking one standalone
 * number (1 to 3 digits) out of the FIRST PART of its name (before the first
 * " + ") leaves `base`; 0 when it IS `base`; null otherwise. A number later in
 * the name ("… + ZF NS1 (EST) 2025") is never a round: the team numbers rounds
 * in the first part (review, 19 Nov).
 */
export function roundOf(candidate: string, base: string): number | null {
  const want = nameKey(base);
  const tokens = nameKey(candidate).split(" ");
  if (tokens.join(" ") === want) return 0;
  const plus = tokens.indexOf("+");
  const headEnd = plus === -1 ? tokens.length : plus;
  for (let i = 0; i < headEnd; i++) {
    if (!/^\d{1,3}$/.test(tokens[i])) continue;
    const without = [...tokens.slice(0, i), ...tokens.slice(i + 1)].join(" ");
    if (without === want) return Number(tokens[i]);
  }
  return null;
}

/** Above this the review says to check the earlier rounds it found (a stray number read as a round). */
export const HIGH_ROUND = 30;

/** The search word that finds every round of `name` in EmailBison's campaign search (its first word). */
export function searchTermFor(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * The names for renewing `source`, given every campaign that could be one of
 * its rounds (EmailBison's live search; the source itself may be among them).
 */
export function planNames(source: NamedCampaign, campaigns: readonly NamedCampaign[]): NamePlan {
  const name = source.name.trim();
  if (!name) return { ok: false, reason: "This campaign has no name, so it cannot be numbered." };
  const others = campaigns.filter((c) => c.id !== source.id);

  // Is the campaign itself an earlier round? When taking one of the numbers in its first part out leaves the name of
  // another campaign (the series' current one), or of a series that has other rounds. Wherever the number sits:
  // "LIV Indy Realty 5 + …" and "C21 Results 1 - Elite Team + …" alike (review, 19 Nov). A number that is part of the
  // brand ("Century 21 + …", "54 Realty + …") with no such series is left alone.
  const tokens = name.split(/\s+/);
  const plus = tokens.indexOf("+");
  const headEnd = plus === -1 ? tokens.length : plus;
  for (let i = 0; i < headEnd; i++) {
    if (!/^\d{1,3}$/.test(tokens[i])) continue;
    const stripped = [...tokens.slice(0, i), ...tokens.slice(i + 1)].join(" ");
    const current = others.find((c) => roundOf(c.name, stripped) === 0);
    const rounds = others.filter((c) => (roundOf(c.name, stripped) ?? 0) > 0);
    if (current || rounds.length) {
      return {
        ok: false,
        reason: current
          ? `This campaign is round ${tokens[i]} of "${current.name}". Renew that one instead.`
          : `This campaign is round ${tokens[i]} of a numbered series. Renew the series' current (unnumbered) campaign instead.`,
      };
    }
  }

  // Other campaigns with exactly this name: named in the review window, never touched.
  const sameName = others
    .filter((c) => roundOf(c.name, name) === 0)
    .map((c) => ({ id: c.id, name: c.name, status: c.status ?? null }));

  const earlier: EarlierRound[] = others
    .map((c) => ({ id: c.id, name: c.name, status: c.status ?? null, round: roundOf(c.name, name) ?? 0 }))
    .filter((c) => c.round > 0)
    .sort((a, b) => a.round - b.round || a.id - b.id);
  let round = (earlier.length ? earlier[earlier.length - 1].round : 0) + 1;
  // Never a name that already exists (a gap filled by hand, a number reused): take the next free one.
  const taken = new Set(campaigns.map((c) => nameKey(c.name)));
  while (taken.has(nameKey(withRound(name, round)))) round++;

  return { ok: true, newName: name, numberedName: withRound(name, round), round, earlier, sameName };
}
