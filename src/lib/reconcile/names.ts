/*
 * Matching client names across tools.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HARDER THAN IT LOOKS
 *
 * Only Analytics joins clients by a real key (`portal_client_id`). Client
 * Health and the Database app both join by NORMALISED NAME. So a rename in
 * Master Inbox silently breaks two of the three joins — and a near-miss like
 * "The Keyes Company" versus "Keyes Co" produces two rows that look like two
 * clients and are one.
 *
 * The output therefore has three buckets, not two:
 *
 *   matched     the same client, agreed by both sides
 *   likely      probably the same client, spelled differently — the useful one
 *   only-in-X   genuinely present in one tool and absent from the other
 *
 * Collapsing `likely` into `matched` would hide real drift. Collapsing it into
 * `only-in-X` would produce a list of "missing" clients that mostly aren't
 * missing, which is the fastest way to get the whole screen ignored.
 */

/**
 * The aggressive form, used for exact matching.
 *
 * Deliberately does NOT strip words like "realty", "group" or "team": those
 * carry meaning here. "Howe Realty Group" and "Howe Team" are plausibly
 * different clients, and merging them would be a silent data error rather than
 * a visible mismatch.
 */
export function normaliseName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ");
}

/** Tokens used for the fuzzy pass. */
function tokens(input: string): string[] {
  // Common company suffixes are dropped HERE only — for similarity scoring,
  // never for exact matching. "Keyes Co" and "The Keyes Company" should score
  // as near-identical without being treated as the same string.
  const NOISE = new Set(["co", "company", "inc", "llc", "ltd", "corp", "the"]);
  return normaliseName(input)
    .split(" ")
    .filter((t) => t.length > 0 && !NOISE.has(t));
}

/**
 * Token overlap, 0..1 (Jaccard).
 *
 * Chosen over edit distance because these are multi-word business names, where
 * word-level agreement is far more meaningful than character-level. "Douglas
 * Elliman NYC" and "Elliman Douglas" are the same firm and score 1.0 here; by
 * edit distance they look distant.
 */
export function similarity(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const t of left) if (right.has(t)) shared++;

  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * How similar two names must be to be called "likely the same".
 *
 * 0.6 means a clear majority of the distinctive words agree. Set lower and
 * unrelated brokerages sharing one common word ("Realty") start pairing up;
 * set higher and genuine abbreviations stop being caught, which is the entire
 * point of the bucket.
 */
export const LIKELY_THRESHOLD = 0.6;

export interface NamedEntry {
  name: string;
  /** Anything the caller wants carried through — counts, ids, plan. */
  meta?: Record<string, unknown>;
}

export interface RosterDiff {
  matched: { name: string; left: NamedEntry; right: NamedEntry }[];
  likely: { left: NamedEntry; right: NamedEntry; score: number }[];
  onlyLeft: NamedEntry[];
  onlyRight: NamedEntry[];
}

/**
 * Compares two client lists.
 *
 * Exact (normalised) matches are taken first and removed from the pool, so a
 * name can never be both an exact match and a fuzzy candidate. The fuzzy pass
 * then runs greedily on what remains, best score first — otherwise a weak pair
 * discovered early could consume a name that was a much better fit for
 * something later in the list.
 */
export function diffRosters(left: NamedEntry[], right: NamedEntry[]): RosterDiff {
  const leftRemaining = new Map(left.map((e) => [normaliseName(e.name), e]));
  const rightRemaining = new Map(right.map((e) => [normaliseName(e.name), e]));

  const matched: RosterDiff["matched"] = [];
  for (const [key, entry] of leftRemaining) {
    const counterpart = rightRemaining.get(key);
    if (counterpart) {
      matched.push({ name: entry.name, left: entry, right: counterpart });
      rightRemaining.delete(key);
    }
  }
  for (const m of matched) leftRemaining.delete(normaliseName(m.left.name));

  // Score every remaining pair, then take the best ones greedily.
  const candidates: { left: NamedEntry; right: NamedEntry; score: number }[] = [];
  for (const l of leftRemaining.values()) {
    for (const r of rightRemaining.values()) {
      const score = similarity(l.name, r.name);
      if (score >= LIKELY_THRESHOLD) candidates.push({ left: l, right: r, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const likely: RosterDiff["likely"] = [];
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  for (const c of candidates) {
    const lk = normaliseName(c.left.name);
    const rk = normaliseName(c.right.name);
    if (usedLeft.has(lk) || usedRight.has(rk)) continue;
    likely.push(c);
    usedLeft.add(lk);
    usedRight.add(rk);
  }

  return {
    matched: matched.sort((a, b) => a.name.localeCompare(b.name)),
    likely: likely.sort((a, b) => b.score - a.score),
    onlyLeft: [...leftRemaining.values()]
      .filter((e) => !usedLeft.has(normaliseName(e.name)))
      .sort((a, b) => a.name.localeCompare(b.name)),
    onlyRight: [...rightRemaining.values()]
      .filter((e) => !usedRight.has(normaliseName(e.name)))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
