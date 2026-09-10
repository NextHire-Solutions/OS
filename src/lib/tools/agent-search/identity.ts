/*
 * identity.ts — the cross-check normalizers from web/server/reconcile.js.
 *
 * VERBATIM. These decide whether a scraped agent is "already in the database"
 * and therefore must NOT be re-inserted. The reconcile pass itself runs inside
 * the live service during an enrichment job; what is ported here is the part
 * with rules worth testing, because each guard below exists for a specific bug:
 *
 *   validPhone10  the `agents` table holds 100+ rows of +10000000000 and a
 *                 handful of +11111111111. A dataset row carrying
 *                 000-000-0000 must NOT match those and be wrongly dropped —
 *                 the write path is insert-new-only, so a false skip silently
 *                 LOSES a real agent.
 *   licenseKey    guards against blanks and junk like "0" / "N/A" being
 *                 treated as an identifier.
 *
 * The tool's own comment: "a wrong fuzzy match would wrongly drop a real new
 * agent."
 */

export function normLicense(v: unknown): string {
  return String(v || "").toUpperCase().replace(/[\s-]+/g, "").trim();
}

export function normPhone(v: unknown): string {
  const d = String(v || "").replace(/\D+/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

export function normEmail(v: unknown): string {
  return String(v || "").trim().toLowerCase();
}

/*
 * Reject junk/placeholder identifiers so they never cause a false "already in
 * DB" skip.
 */
export function validPhone10(d: string): boolean {
  if (!/^\d{10}$/.test(d)) return false;
  if (/^(\d)\1{9}$/.test(d)) return false;      // all one digit
  return d[0] >= "2" && d[3] >= "2";            // NANP: area + exchange start 2-9
}

export function validEmail(e: unknown): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || "").trim());
}

/*
 * A license is a usable identifier only if it's a plausible number/alnum code
 * (>=4 chars, not all zeros). Matched EXACTLY against license_number, which is
 * the DB app's own dedup key ('lic:<number>'). '' when there's nothing safe.
 */
export function licenseKey(v: unknown): string {
  const s = String(v || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,}$/.test(s)) return "";
  if (/^0+$/.test(s)) return "";
  return s;
}
