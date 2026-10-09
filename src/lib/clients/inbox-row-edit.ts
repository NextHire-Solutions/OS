import { keyOf } from "./roster.ts";

/*
 * Renaming a client's Master Inbox row and editing its spellings, from the
 * client's record (9 Oct — moved off Master Inbox → Settings → Clients, which
 * was removed). Pure, so every rule is tested without a database.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW'S NAME AND SPELLINGS DECIDE
 *
 *   - Which client an inbound reply belongs to: Master Inbox matches the
 *     campaign name against every row's name and aliases (derive.ts).
 *   - Which master client a portal row belongs to: the OS matches the row's
 *     NAME against the client's name and aliases (people.ts portalsFor).
 *   - The portal's on/off by status: Master Inbox matches the status feed by
 *     NAME (status-sync.ts).
 *
 * The portal's link is its token, which nothing here touches.
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 *
 *   1. A rename keeps the old name as a spelling, so replies from campaigns
 *      named the old way keep arriving here.
 *   2. A rename adds the new name to the CLIENT's spellings when the client
 *      does not already answer to it — otherwise the record would lose sight
 *      of its own portal.
 *   3. Never take a name or spelling that is another inbox row's name, or
 *      another client's name or spelling: replies would be routed across
 *      clients (the Properties & Estates Boston/Florida trap, inbox-aliases.ts).
 *   4. The "Unknown" fallback row is never edited.
 */

export interface InboxRowLite {
  id: string;
  name: string;
  slug?: string | null;
  aliases: string[] | null;
}

export interface MasterLite {
  id: string;
  name: string;
  aliases: string[] | null;
}

export interface RowEditPlan {
  ok: boolean;
  errors: string[];
  /** What changes, said plainly — shown before saving. */
  notes: string[];
  /** The Master Inbox update: only the fields that change. */
  update: { name?: string; aliases?: string[] };
  /** A spelling to add to the master client, or null. */
  addToClient: string | null;
}

export const MAX_ALIASES = 20;

function clean(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const a = (raw ?? "").trim();
    const k = keyOf(a);
    if (!a || !k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function planInboxRowEdit(input: {
  row: InboxRowLite;
  client: MasterLite;
  /** Every Master Inbox row (to spot another row's name). */
  rows: InboxRowLite[];
  /** Every master client (to spot another client's name or spelling). */
  clients: MasterLite[];
  name?: string;
  aliases?: string[];
}): RowEditPlan {
  const { row, client, rows, clients } = input;
  const errors: string[] = [];
  const notes: string[] = [];
  const update: RowEditPlan["update"] = {};

  if (row.slug === "unknown") {
    return { ok: false, errors: ["The Unknown fallback row cannot be renamed or given spellings."], notes, update, addToClient: null };
  }

  // Whose is a spelling? Another inbox row's name, or another client's name/spelling.
  const otherRow = new Map<string, string>();
  for (const r of rows) if (r.id !== row.id) otherRow.set(keyOf(r.name), r.name);
  const otherClient = new Map<string, string>();
  for (const c of clients) {
    if (c.id === client.id) continue;
    for (const n of [c.name, ...(c.aliases ?? [])]) if (n?.trim()) otherClient.set(keyOf(n), c.name);
  }
  const clash = (s: string): string | null => {
    const k = keyOf(s);
    if (otherRow.has(k)) return `"${otherRow.get(k)}" is another portal in Master Inbox`;
    if (otherClient.has(k)) return `it is a name of another client, ${otherClient.get(k)}`;
    return null;
  };

  const oldName = row.name.trim();
  const newName = input.name === undefined ? oldName : input.name.trim();
  const renamed = keyOf(newName) !== keyOf(oldName) || newName !== oldName;
  if (!newName) errors.push("The name cannot be empty.");
  else if (newName.length > 80) errors.push(`The name is ${newName.length} characters; Master Inbox allows 80.`);
  else if (renamed && keyOf(newName) !== keyOf(oldName)) {
    const why = clash(newName);
    if (why) errors.push(`Cannot rename to "${newName}": ${why}.`);
  }

  let aliases = clean(input.aliases ?? row.aliases ?? []);
  for (const a of aliases) if (a.length > 120) errors.push(`"${a.slice(0, 40)}…" is longer than 120 characters.`);
  // Rule 1: the old name stays as a spelling.
  if (renamed && keyOf(newName) !== keyOf(oldName) && !aliases.some((a) => keyOf(a) === keyOf(oldName))) {
    aliases = [...aliases, oldName];
    notes.push(`"${oldName}" is kept as a spelling, so replies from campaigns named that way still arrive here.`);
  }
  // A spelling equal to the row's own name says nothing.
  aliases = aliases.filter((a) => keyOf(a) !== keyOf(newName));
  if (aliases.length > MAX_ALIASES) errors.push(`At most ${MAX_ALIASES} spellings (${aliases.length} given).`);
  // Rule 3, for spellings — only the ones being ADDED; one already there is left alone.
  const had = new Set((row.aliases ?? []).map(keyOf));
  for (const a of aliases) {
    if (had.has(keyOf(a)) || keyOf(a) === keyOf(oldName)) continue;
    const why = clash(a);
    if (why) errors.push(`Cannot add the spelling "${a}": ${why}.`);
  }

  if (newName !== oldName) {
    update.name = newName;
    notes.push(`Renames "${oldName}" to "${newName}" in Master Inbox. The portal's link does not change.`);
  }
  const before = clean(row.aliases ?? []);
  const changed = before.length !== aliases.length || before.some((a, i) => a !== aliases[i]);
  if (changed) {
    update.aliases = aliases;
    const added = aliases.filter((a) => !before.some((b) => keyOf(b) === keyOf(a)));
    const removed = before.filter((b) => !aliases.some((a) => keyOf(a) === keyOf(b)));
    if (added.length) notes.push(`Adds the spelling${added.length === 1 ? "" : "s"} ${added.map((a) => `"${a}"`).join(", ")}.`);
    if (removed.length) notes.push(`Removes the spelling${removed.length === 1 ? "" : "s"} ${removed.map((a) => `"${a}"`).join(", ")} — replies from campaigns named only that way will no longer match this portal.`);
  }

  // Rule 2: the client must still answer to this row's name.
  let addToClient: string | null = null;
  if (update.name) {
    const answers = [client.name, ...(client.aliases ?? [])].some((n) => keyOf(n ?? "") === keyOf(newName));
    if (!answers) {
      addToClient = newName;
      notes.push(`Adds "${newName}" to ${client.name}'s spellings, which is how its record finds this portal.`);
    }
    notes.push("Portals switch on and off with the client's status by matching names with Client Health. If Client Health still uses the old name, this portal keeps its current on/off state until the names match.");
  }

  if (!update.name && !update.aliases && !errors.length) errors.push("Nothing to change.");
  return { ok: errors.length === 0, errors, notes, update, addToClient };
}
