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
