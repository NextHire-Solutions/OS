/*
 * The canonical client roster.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every tool keeps its own client list and they disagree — Master Inbox has 57
 * rows, Client Health 48, Analytics 50, and no two agree on spelling. Asking
 * "how many clients do we have?" produced three answers and a fortnight of
 * tickets.
 *
 * This is the answer: one list, supplied by the business, that every screen in
 * the workspace counts against. The tools keep their own rows — nothing is
 * migrated or renamed in any live system — but the workspace stops treating
 * any of them as the truth and starts measuring them against this.
 *
 * ---------------------------------------------------------------------------
 * MAINTAINING IT
 *
 * Kept in code rather than a database on purpose, for now. It changes a few
 * times a month, it must be reviewable in a diff, and a wrong entry here would
 * quietly mis-state every count in the workspace. A pull request is the right
 * weight of ceremony for that. It moves to the database when Team access does.
 *
 * `aliases` are spellings a TOOL uses, not trading names. Add one only after
 * seeing the tool actually use it — a guessed alias silently merges two
 * clients, which is worse than the mismatch it was meant to fix.
 */

export interface CanonicalClient {
  /** The name the business uses. Shown everywhere in the workspace. */
  name: string;
  /** Spellings observed in the tools, so their rows can be matched to this one. */
  aliases?: string[];
}

export const ROSTER: CanonicalClient[] = [
  { name: "54 Realty" },
  { name: "Bastion Realty South" },
  { name: "BHGRE Base Camp", aliases: ["BHGRE Basecamp"] },
  { name: "Brooklyn Group" },
  { name: "C21 Results Elite Team", aliases: ["C21 Results - Elite Team"] },
  { name: "Camelot Realty Group" },
  { name: "Carolina Realty Advisors" },
  { name: "ChuckTown Homes Team" },
  { name: "Discover Flag Team" },
  { name: "Discover Phx Team", aliases: ["The Discover Phx Team"] },
  { name: "Douglas Elliman LA" },
  { name: "Douglas Elliman Las Vegas" },
  { name: "Douglas Elliman NYC" },
  { name: "FAST Real Estate", aliases: ["Fast Real Estate"] },
  { name: "Howe Realty Group" },
  { name: "Jeff Cook Real Estate" },
  { name: "JPAR Iron Horse Real Estate", aliases: ["JPAR Ironhorse Real Estate"] },
  { name: "LIV Indy Realty" },
  { name: "Maltos Realty Group" },
  { name: "MattC Group" },
  { name: "Momentum Realty" },
  { name: "Norvell&Co Real Estate" },
  { name: "Oz Group" },
  { name: "PRG Real Estate at eXp", aliases: ["PRG Real Estate at EXP"] },
  { name: "Properties & Estates", aliases: ["Properties & Estates Florida"] },
  { name: "Raintown Realty" },
  { name: "RE/MAX Pacific" },
  { name: "Rise Real Estate Tujunga" },
  { name: "SERHANT. NJ" },
  { name: "SERHANT. PA", aliases: ["SERHANT. PA 15M+"] },
  { name: "Spotlight - A Compass Team" },
  { name: "The Keyes Company" },
  { name: "The Rafeh Group" },
  { name: "The RE Home Group of Douglas Realty" },
  { name: "The Wurst Team" },
  { name: "Wagner Real Estate Group", aliases: ["M Wagner Team"] },
];

/*
 * Entries that legitimately exist in a tool and are deliberately NOT billed
 * clients. The workspace must never present these as clutter to clean up.
 *
 * "Demo Portal" is the one that matters: it backs a live demonstration client
 * portal. Listing it as an unrecognised extra would invite someone to delete
 * it and take that portal down with it.
 *
 * Nothing here is ever removed from any tool — the workspace has no write
 * access to their rosters and this list only changes how a row is LABELLED.
 */
export const NOT_CLIENTS: { name: string; reason: string }[] = [
  { name: "Demo Portal", reason: "backs the live demo client portal — keep" },
  { name: "New client portal", reason: "portal scaffolding, not a client" },
  { name: "Test FUB", reason: "test entry" },
  { name: "Unassigned", reason: "Analytics bucket for unmatched campaigns" },
  { name: "Unknown", reason: "Master Inbox bucket for unattributed replies" },
];

const NOT_CLIENT_KEYS = new Set(NOT_CLIENTS.map((n) => keyOf(n.name)));

/** True when a tool row is a known non-client rather than a discrepancy. */
export function isKnownNonClient(name: string): boolean {
  return NOT_CLIENT_KEYS.has(keyOf(name));
}

/** The reason a row is exempt, for the screen to show instead of an alarm. */
export function nonClientReason(name: string): string | null {
  return NOT_CLIENTS.find((n) => keyOf(n.name) === keyOf(name))?.reason ?? null;
}

/**
 * The comparison key.
 *
 * Deliberately aggressive — punctuation, case, spacing and a leading "the" all
 * vanish, so "The Discover Phx Team" and "Discover Phx Team" collapse together
 * without needing an alias. What it does NOT do is drop words like "Realty" or
 * "Group": those distinguish real clients, and merging on them would join two
 * businesses into one row.
 */
export function keyOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ");
}

/** Every key that should resolve to a given canonical client. */
function keysFor(client: CanonicalClient): string[] {
  return [client.name, ...(client.aliases ?? [])].map(keyOf);
}

const INDEX: Map<string, CanonicalClient> = new Map(
  ROSTER.flatMap((c) => keysFor(c).map((k) => [k, c] as const)),
);

/** The canonical client a tool's row refers to, or null if it is not on the roster. */
export function resolve(toolName: string): CanonicalClient | null {
  return INDEX.get(keyOf(toolName)) ?? null;
}

export interface RosterMatch {
  /** Tool rows that map onto a canonical client. */
  matched: Map<string, string[]>;
  /** Canonical clients no tool row mapped to. */
  missing: CanonicalClient[];
  /** Tool rows that map to nobody on the roster and are not known exemptions. */
  unknown: string[];
  /** Rows that are deliberately not clients — reported separately, never as a problem. */
  exempt: { name: string; reason: string }[];
}

/**
 * Compares one tool's client names against the roster.
 *
 * `unknown` is the interesting output and is reported, never discarded: a name
 * the roster does not recognise is either a client nobody told us about or a
 * spelling that needs an alias. Silently dropping it is how a live client
 * disappears from every count in the workspace.
 */
export function matchRoster(toolNames: string[]): RosterMatch {
  const matched = new Map<string, string[]>();
  const unknown: string[] = [];

  const exempt: { name: string; reason: string }[] = [];

  for (const name of toolNames) {
    const client = resolve(name);
    if (!client) {
      const reason = nonClientReason(name);
      if (reason) exempt.push({ name, reason });
      else unknown.push(name);
      continue;
    }
    const seen = matched.get(client.name) ?? [];
    seen.push(name);
    matched.set(client.name, seen);
  }

  return {
    matched,
    missing: ROSTER.filter((c) => !matched.has(c.name)),
    unknown,
    exempt,
  };
}
