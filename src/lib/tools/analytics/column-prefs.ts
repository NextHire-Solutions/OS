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
 */

export interface ColumnCarry {
  from: number;
  add: readonly string[];
}

export function restoreColumns(
  raw: string | null,
  version: number,
  carry?: ColumnCarry,
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
  if (carry && s.version === carry.from) {
    return { visible: [...visible, ...carry.add.filter((k) => !visible.includes(k))], upgraded: true };
  }
  return null;
}
