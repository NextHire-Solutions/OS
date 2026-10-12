import type { ClientCounts, CountedTool } from "./client-counts";

/** Why a row in this tool is not one more client — "second portal of …" / "not a client" — or null. */
export function rowNote(c: ClientCounts | null, tool: CountedTool, name: string): string | null {
  const t = c?.tools[tool];
  if (!t) return null;
  const second = t.secondRows.find((r) => r.name === name);
  if (second) return `second portal of ${second.of} — counted once`;
  const extra = t.extras.find((r) => r.name === name);
  if (extra) return `not a client${extra.reason ? ` — ${extra.reason}` : ""}`;
  return null;
}

/*
 * A tool's table as ONE SCREEN lists it.
 *
 * `omit` names rows the table holds that the screen leaves out — Client
 * Portals does not list Master Inbox's "Unknown" bucket. They come off the row
 * count and out of the rows named as "not a client", so the sentence under the
 * count ("This table has 57 portals: …") adds up to what is on the screen.
 * Only rows that are NOT clients can be omitted: leaving out a client's row
 * would make the line claim a client the screen does not show.
 */
export function listed(
  t: { rows: number; extras: { name: string; reason: string }[] },
  omit: readonly string[] = [],
): { rows: number; extras: { name: string; reason: string }[] } {
  const extras = t.extras.filter((r) => !omit.includes(r.name));
  return { rows: t.rows - (t.extras.length - extras.length), extras };
}
