/*
 * Spellings a tool does not know — §16 "conflicting data", applied to identity.
 *
 * An alias is not decoration. Analytics, Client Health and the campaign matcher
 * all attribute campaigns by NAME, so a spelling recorded in the master and
 * missing from a tool means that tool is looking at a different set of
 * campaigns for the same client. Measured on the day this was written: Client
 * Health knew an alias for 1 of its 50 rows while the master held them for 19,
 * and three "Douglas Elliman Los Angeles" campaigns were attributed to nobody
 * because Analytics only knew "Douglas Elliman LA".
 *
 * ---------------------------------------------------------------------------
 * ONLY MISSING SPELLINGS ARE DRIFT
 *
 * Two things that look like disagreement are deliberately NOT reported:
 *
 *  1. A tool holding an alias the master does not. Tools acquire spellings from
 *     their own campaign data; an extra one costs nothing and removing it could
 *     unattribute a campaign. Only absence breaks matching.
 *
 *  2. A master alias that IS the tool's own NAME. Every tool matches on its own
 *     name first, so "Momentum Lux Realty" as an alias of "Momentum Realty" is
 *     already matched by the Analytics row literally called "Momentum Lux
 *     Realty". Reporting it produced 96 findings that changed no matching at
 *     all; excluding it left 20 real ones.
 *
 * Pure, so the rule the screen shows and the rule a backfill applies are the
 * same rule.
 */

export type AliasTool = "analytics" | "client_health";

export const ALIAS_TOOL_LABELS: Record<AliasTool, string> = {
  analytics: "Analytics",
  client_health: "Client Health",
};

/** How every matcher in the platform compares two names. */
const norm = (s: unknown): string =>
  typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : "";

export interface AliasToolRow {
  id: string;
  name: string;
  /** Analytics calls it `aliases`; Client Health calls it `campaign_aliases`. */
  aliases: string[];
}

export interface AliasClient {
  name: string;
  aliases: string[];
  /** The row id this client has in each tool, as os_clients records it. */
  links: Partial<Record<AliasTool, string | null>>;
}

export interface AliasFinding {
  client: string;
  tool: AliasTool;
  label: string;
  /** Spellings the master knows and the tool does not. */
  missing: string[];
  detail: string;
}

export interface AliasDriftReport {
  findings: AliasFinding[];
  /** Client/tool pairs where every spelling is known. */
  sound: number;
  /** Tools whose rows could not be read. */
  unchecked: AliasTool[];
}

export interface AliasToolInput {
  rows: Map<string, AliasToolRow>;
  unreadable?: boolean;
}

export function findAliasDrift(
  clients: AliasClient[],
  tools: Partial<Record<AliasTool, AliasToolInput>>,
): AliasDriftReport {
  const findings: AliasFinding[] = [];
  const unchecked: AliasTool[] = [];
  let sound = 0;

  for (const [tool, input] of Object.entries(tools) as [AliasTool, AliasToolInput][]) {
    if (!input || input.unreadable) {
      unchecked.push(tool);
      continue;
    }
    const label = ALIAS_TOOL_LABELS[tool];

    for (const client of clients) {
      const link = client.links[tool] ?? null;
      if (!link) continue; // not linked yet — the link checker's business, not ours
      const row = input.rows.get(link);
      if (!row) continue; // stale link — likewise reported elsewhere

      // What the tool already matches on: its own name, plus its own aliases.
      const known = new Set<string>([norm(row.name), ...(row.aliases ?? []).map(norm)]);
      known.delete("");

      const missing: string[] = [];
      for (const spelling of [client.name, ...(client.aliases ?? [])]) {
        const key = norm(spelling);
        if (!key || known.has(key)) continue;
        if (missing.some((m) => norm(m) === key)) continue;
        missing.push(String(spelling));
      }

      if (missing.length === 0) {
        sound += 1;
        continue;
      }
      findings.push({
        client: client.name,
        tool,
        label,
        missing,
        detail:
          `${label} does not know ${missing.map((m) => `"${m}"`).join(", ")}. ` +
          "It attributes campaigns by name, so any campaign named that way is being " +
          "counted against nobody.",
      });
    }
  }

  findings.sort((a, b) => a.client.localeCompare(b.client) || a.tool.localeCompare(b.tool));
  return { findings, sound, unchecked };
}
