/*
 * What a saved column choice becomes when a table is opened (shared.tsx's
 * useColumnPrefs). Pure, so the rules are tested without a browser.
 *
 * A choice saved at this version is used as it is. A choice saved before
 * columns were added would hide them forever, so the hook's caller can name
 * the version it upgrades from and the columns that came with the new one:
 * that choice keeps everything it had and gains those (14 Nov, the Inboxes
 * page's Positive replies). Any other version, or anything unreadable, gives
 * nothing — the table's defaults.
 *
 * Several steps can be named, one per version (18 Nov, Bounce rate): each step
 * leads to the next step's version, the last to the current one, so a choice
 * saved two versions back gains the columns of both. A single step behaves
 * exactly as it always has.
 */

export interface ColumnCarry {
  from: number;
  add: readonly string[];
}

export function restoreColumns(
  raw: string | null,
  version: number,
  carry?: ColumnCarry | readonly ColumnCarry[],
): { visible: string[]; upgraded: boolean } | null {
  if (!raw) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  const s = saved as { version?: unknown; visible?: unknown } | null;
  if (!s || !Array.isArray(s.visible)) return null;
  const visible = s.visible.filter((k): k is string => typeof k === "string");
  if (!visible.length) return null;
  if (s.version === version) return { visible, upgraded: false };
  const steps = (carry === undefined ? [] : "from" in carry ? [carry] : [...carry]).sort((a, b) => a.from - b.from);
  const first = steps.findIndex((step) => step.from === s.version);
  if (first < 0) return null;
  const out = [...visible];
  for (const step of steps.slice(first)) for (const k of step.add) if (!out.includes(k)) out.push(k);
  return { visible: out, upgraded: true };
}
