/*
 * How the Database app decides two client names are the same client.
 *
 * This is a DELIBERATE MIRROR of `normClientName` in
 *   Corofy/Database/src/lib/bison/match-campaign.ts
 * and it must stay byte-compatible with it:
 *
 *     lowercase -> drop "copy of" -> strip non-alphanumerics -> drop a leading "the"
 *
 * ---------------------------------------------------------------------------
 * WHY THE OS HAS TO KNOW THIS RULE
 *
 * The OS now creates the Database record (§2 "Create the Database record",
 * §21 step 3). That row is matched to campaigns every six hours by the rule
 * above, and `makeCampaignMatcher` REFUSES TO GUESS on a tie: if two
 * orch_clients rows reduce to the same key, it returns null for BOTH and their
 * leads silently stop being attributed.
 *
 * So creating a row whose key collides with an existing one does not create a
 * duplicate — it breaks the client that was already there. The Database app's
 * own create path had exactly this hole: its guard normalised in SQL without
 * dropping "copy of" or a leading "the", so "Keyes Company" was accepted
 * alongside "The Keyes Company". Measured before that was fixed: all 46
 * clients were reachable this way, with 36,586 lead rows behind the 18 that
 * have leads.
 *
 * Mirroring a rule is normally the wrong answer and one definition imported by
 * both is the right one — but these are two separate deployed applications
 * with two separate databases and no shared package, so a copy with a test
 * pinning the exact behaviour is the honest option. The test below is the
 * contract; if the Database app's rule changes, that test is what fails.
 */

/** Byte-compatible with the Database app's `normClientName`. */
export function orchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bcopy of\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^the/, "");
}

export interface OrchRow {
  id: string;
  client_name: string | null;
}

/**
 * The existing row this name would collide with under the campaign matcher, or
 * null when the name is genuinely new.
 *
 * A collision is NOT an error here: the OS's job is to make sure the client has
 * a Database record, and an existing row IS that record. So the caller links to
 * what it finds rather than inserting beside it — which is both idempotent and
 * the only safe answer, since inserting would break the existing client.
 */
export function findOrchCollision(name: string, rows: OrchRow[]): OrchRow | null {
  const key = orchKey((name ?? "").trim());
  if (!key) return null;
  for (const row of rows) {
    const other = (row.client_name ?? "").trim();
    if (!other) continue;
    if (orchKey(other) === key) return row;
  }
  return null;
}

/**
 * Whether the matcher could ever match this name at all.
 *
 * `makeCampaignMatcher` skips clients whose normalised name is shorter than 3
 * characters, because a 1-2 character key matches almost anything under its
 * startsWith scoring. A row created with such a name would therefore never be
 * attributed any campaign — a silent dead end worth naming at creation time.
 */
export function isMatchableOrchName(name: string): boolean {
  return orchKey((name ?? "").trim()).length >= 3;
}
