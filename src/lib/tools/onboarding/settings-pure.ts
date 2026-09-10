/**
 * The pure half of the settings store — importable from tests and client code.
 *
 * `settings.ts` is `server-only` because it holds the Supabase calls, and a
 * `server-only` import throws under `node --test`. This rule is worth testing:
 * storing "" as a caption would produce a button with no text on it.
 */

/**
 * Strip blanks before storing.
 *
 * A blank box means "use the default caption", not "the caption is empty".
 */
export function cleanStepLabels(labels: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (typeof v === "string" && v.trim()) clean[k] = v.trim();
  }
  return clean;
}
