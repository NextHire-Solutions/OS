import { keyOf } from "@/lib/clients/roster";

/*
 * Duplicate clients — the one §16 provision that was never built.
 *
 * §16 asks the system to surface "sync status, last synchronized date/time,
 * error state, failed connection, missing record, DUPLICATE RECORD, conflicting
 * data", and §22 makes "Duplicate clients are detectable" a condition of done.
 * Everything on that list was implemented except duplicates: the link checker
 * reports stale / disagrees / unlinked, none of which is a duplicate.
 *
 * Measured when this was written: ZERO duplicates existed. That is the argument
 * for adding the check now rather than later — it lands silent, so the first
 * thing it ever reports is a real one, on a screen nobody has learned to
 * ignore.
 *
 * ---------------------------------------------------------------------------
 * TWO SHAPES, BECAUSE THEY BREAK DIFFERENTLY
 *
 * 1. NAME — two master rows that resolve to the same key. Every tool in the
 *    platform joins clients by normalised name, so this does not merely look
 *    untidy: whichever row a tool matches first wins, and the two masters then
 *    disagree about the same real client forever. The campaign matcher is
 *    stricter still — it refuses to guess on a tie, so BOTH rows stop being
 *    matched and their leads quietly lose attribution.
 *
 * 2. LINK — two master rows storing the same tool row id. One tool row cannot
 *    belong to two clients; one of the two links must be wrong, and a status
 *    written through either will fight the other.
 *
 * `keyOf` is the roster diff's own comparison key, not a private one, so a
 * duplicate reported here is a duplicate exactly as the rest of the screen
 * sees it. A second normalisation rule is how the create-path guard in the
 * Database app came to accept names its own matcher then treated as identical.
 *
 * ALIASES COUNT AS NAMES. An alias is identity here — that is what makes
 * "Properties & Estates Florida" the same client as "Properties & Estates" —
 * so a name that collides with another client's ALIAS is just as ambiguous as
 * one colliding with its name, and is reported.
 *
 * Pure and dependency-free apart from keyOf, so the test imports THIS rather
 * than keeping a copy of the rule.
 */

export type DuplicateTool = "master_inbox" | "client_health" | "analytics" | "onboarding";

export const DUPLICATE_TOOL_LABELS: Record<DuplicateTool, string> = {
  master_inbox: "Master Inbox",
  client_health: "Client Health",
  analytics: "Analytics",
  onboarding: "Onboarding",
};

export interface DuplicateClient {
  id: string;
  name: string;
  aliases?: string[] | null;
  /** The row id this client has in each tool, as os_clients records it. */
  links?: Partial<Record<DuplicateTool, string | null>>;
}

export interface DuplicateFinding {
  kind: "name" | "link";
  /** The colliding value: a normalised name, or the shared tool row id. */
  key: string;
  /** Which tool's link is shared. Only set for `kind: "link"`. */
  tool?: DuplicateTool;
  /** The master clients involved, by display name, in input order. */
  clients: { id: string; name: string; /** the spelling that collided */ via: string }[];
  /** One sentence a person can act on. */
  detail: string;
}

export interface DuplicateReport {
  findings: DuplicateFinding[];
  /** Master rows examined, so "0 findings" is distinguishable from "0 rows". */
  checked: number;
}

/** Every spelling a client is known by — its name first, then its aliases. */
function spellings(c: DuplicateClient): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [c.name, ...(c.aliases ?? [])]) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const key = keyOf(name);
    if (!key || seen.has(key)) continue; // a client repeating itself is not a duplicate
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function findDuplicates(clients: DuplicateClient[]): DuplicateReport {
  const findings: DuplicateFinding[] = [];

  /* ---- 1. two master rows resolving to the same name key ---- */
  const byKey = new Map<string, { id: string; name: string; via: string }[]>();
  for (const c of clients) {
    for (const spelling of spellings(c)) {
      const key = keyOf(spelling);
      if (!byKey.has(key)) byKey.set(key, []);
      const holders = byKey.get(key)!;
      // Guard against the same client appearing twice under one key.
      if (holders.some((h) => h.id === c.id)) continue;
      holders.push({ id: c.id, name: c.name, via: spelling });
    }
  }
  for (const [key, holders] of byKey) {
    if (holders.length < 2) continue;
    const names = holders.map((h) => (h.via === h.name ? `"${h.name}"` : `"${h.name}" (as "${h.via}")`));
    findings.push({
      kind: "name",
      key,
      clients: holders,
      detail:
        `${holders.length} master clients resolve to the same name — ${names.join(" and ")}. ` +
        "Every tool joins clients by normalised name, so which one a tool matches is arbitrary, " +
        "and the campaign matcher refuses to guess on a tie: both would lose their attribution.",
    });
  }

  /* ---- 2. two master rows storing the same tool row id ---- */
  const TOOLS: DuplicateTool[] = ["master_inbox", "client_health", "analytics", "onboarding"];
  for (const tool of TOOLS) {
    const byLink = new Map<string, { id: string; name: string; via: string }[]>();
    for (const c of clients) {
      const link = c.links?.[tool];
      if (!link) continue;
      if (!byLink.has(link)) byLink.set(link, []);
      const holders = byLink.get(link)!;
      if (holders.some((h) => h.id === c.id)) continue;
      holders.push({ id: c.id, name: c.name, via: link });
    }
    for (const [link, holders] of byLink) {
      if (holders.length < 2) continue;
      findings.push({
        kind: "link",
        key: link,
        tool,
        clients: holders,
        detail:
          `${holders.length} master clients point at the same ${DUPLICATE_TOOL_LABELS[tool]} row — ` +
          `${holders.map((h) => `"${h.name}"`).join(" and ")}. One row cannot belong to two clients, ` +
          "so one of these links is wrong and a status written through either will fight the other.",
      });
    }
  }

  return { findings, checked: clients.length };
}
