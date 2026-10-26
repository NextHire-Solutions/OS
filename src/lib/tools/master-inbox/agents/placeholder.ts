/*
 * What an import writes for "nothing" — Python's None, null, N/A, a dash —
 * is not a phone number or an email address. It is never shown as one, never
 * offered as a choice, and never saved (26 Oct: a lead's phone list held
 * "None", because the number shown before a second one was added was the
 * imported text "None").
 */
const PLACEHOLDERS = new Set(["none", "null", "nil", "undefined", "n/a", "na", "-", "--", "—", "0"]);

/** True for an empty value or one of the placeholders, case and spaces aside. */
export function isPlaceholder(v: unknown): boolean {
  if (typeof v !== "string") return true;
  const t = v.trim().toLowerCase();
  return t === "" || PLACEHOLDERS.has(t);
}

/** The value, trimmed — or null when it is empty or a placeholder. */
export function realValue(v: unknown): string | null {
  return typeof v === "string" && !isPlaceholder(v) ? v.trim() : null;
}

/** A phone number has at least seven digits; "None" or "call me" does not. */
export function looksLikePhone(v: string): boolean {
  return !isPlaceholder(v) && (v.match(/\d/g) ?? []).length >= 7;
}
