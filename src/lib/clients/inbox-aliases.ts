/*
 * Keeping Master Inbox's spellings in step with the master record.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MATTERS MORE THAN THE OTHER ALIAS STORES
 *
 * Analytics and Client Health use aliases to attribute campaigns. Master Inbox
 * uses them in `deriveClientIdFromCampaign`, which decides who an INBOUND reply
 * belongs to — it runs in the EmailBison sync, the Instantly sync and the
 * external-introductions path. An alias it does not know sends that reply to
 * the "Unknown" bucket instead of the client, and introductions are what the
 * customer sees in their own portal.
 *
 * Measured 28 Sep: nine clients had a spelling in `os_clients` that Master
 * Inbox did not, and 82 of 11,460 threads sat under "Unknown".
 *
 * ---------------------------------------------------------------------------
 * UNION, NEVER REPLACE
 *
 * Master Inbox acquires spellings from its own campaign data, so it holds
 * aliases the master record has never seen. Overwriting would remove them and
 * silently unattribute whatever they were matching — which is the same reason
 * `alias-drift.ts` reports only MISSING spellings as drift and treats an extra
 * one as harmless.
 *
 * ---------------------------------------------------------------------------
 * NEVER ADOPT ANOTHER CLIENT'S NAME
 *
 * The trap this exists to avoid. "Properties & Estates" carries the alias
 * "Properties & Estates Florida", because from the master record's point of
 * view Florida is the same client. But Master Inbox keeps ONE ROW PER PORTAL,
 * so "Properties & Estates Florida" is the NAME of a different row there.
 * Copying it onto the Boston row would make Boston match Florida's campaigns,
 * and every Florida reply would land on the wrong client.
 *
 * So an alias that is the name of any other Master Inbox row is skipped, and
 * said out loud in the result rather than dropped quietly.
 */

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface InboxRow {
  id: string;
  name: string;
  aliases: string[] | null;
}

export interface AliasPlan {
  /** The full list to write, existing ones included. Empty when nothing changes. */
  next: string[];
  /** Spellings this write adds. */
  added: string[];
  /** Skipped because they name a different Master Inbox row, with that row's name. */
  skipped: { alias: string; because: string }[];
  /** True when there is nothing to write. */
  noop: boolean;
}

/**
 * Work out what Master Inbox's alias list should become.
 *
 * `target` is the row this client is linked to; `allRows` is every row in the
 * tool, needed only to recognise another row's name.
 */
export function planInboxAliases(
  masterAliases: string[],
  target: InboxRow,
  allRows: InboxRow[],
): AliasPlan {
  const existing = (target.aliases ?? []).filter((a) => a && a.trim());
  const have = new Set(existing.map(norm));
  have.add(norm(target.name));

  /** Every OTHER row's name — the spellings that must never be adopted. */
  const otherNames = new Map<string, string>();
  for (const r of allRows) {
    if (r.id === target.id) continue;
    otherNames.set(norm(r.name), r.name);
  }

  const added: string[] = [];
  const skipped: { alias: string; because: string }[] = [];

  for (const raw of masterAliases) {
    const alias = (raw ?? "").trim();
    if (!alias) continue;
    const key = norm(alias);
    if (!key || have.has(key)) continue;

    const clash = otherNames.get(key);
    if (clash) {
      skipped.push({ alias, because: `"${clash}" is a separate row in Master Inbox` });
      continue;
    }
    added.push(alias);
    have.add(key);
  }

  return {
    next: added.length ? [...existing, ...added] : existing,
    added,
    skipped,
    noop: added.length === 0,
  };
}
