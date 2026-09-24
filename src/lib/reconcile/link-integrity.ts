/*
 * Whether the links os_clients records still point where they should.
 *
 * `os_clients` stores which row is this client's in each tool — mi_client_id,
 * ch_client_id, an_client_id, orch_client_id. Those links are now what the
 * Clients screen resolves by, so they have gone from documentation to load
 * bearing, and a wrong one is no longer harmless.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM COVERAGE
 *
 * The coverage panel deliberately matches on NAME, because it exists to catch
 * cases where what we believe about a client is wrong — resolving by the
 * stored id there would use the belief to check the belief, and a stale id
 * pointing at a deleted row would read as "present".
 *
 * This checks the belief itself. Three things can be wrong with a link, and
 * they want different actions:
 *
 *   stale       the id points at nothing. The row it named is gone. Today the
 *               name fallback still finds the client, so nothing is visibly
 *               broken — which is exactly why it needs saying out loud,
 *               because it breaks silently on the day names stop being the
 *               join.
 *
 *   disagrees   the id and the name resolve to DIFFERENT rows. One of the two
 *               is wrong about which row belongs to this client, and until
 *               somebody says which, two screens can honestly disagree.
 *
 *   unlinked    no id stored, but the name finds a row. Nothing is broken;
 *               there is simply a link waiting to be recorded, and recording
 *               it is what makes that client survive its next rename.
 *
 * `unlinked` is deliberately ranked lowest. It is the normal state for most
 * of a migration and flagging it loudly would bury the two that matter.
 */

export type LinkTool = "master_inbox" | "client_health" | "analytics" | "onboarding";

export const LINK_TOOL_LABELS: Record<LinkTool, string> = {
  master_inbox: "Master Inbox",
  client_health: "Client Health",
  analytics: "Analytics",
  onboarding: "Onboarding",
};

export type LinkProblem = "stale" | "disagrees" | "unlinked";

export interface LinkFinding {
  client: string;
  tool: LinkTool;
  label: string;
  kind: LinkProblem;
  detail: string;
}

export interface LinkReport {
  findings: LinkFinding[];
  /** Links that resolve and agree with the name. The number that should be big. */
  sound: number;
  /** Tools that could not be read, so their links were not checked at all. */
  unchecked: LinkTool[];
}

export interface LinkClient {
  name: string;
  /** Normalised name plus aliases — how the name route resolves. */
  keys: string[];
  /** The stored link per tool; null when none is recorded. */
  links: Partial<Record<LinkTool, string | null>>;
}

export interface ToolRows {
  /** id -> display name. Empty when the tool's rows carry no id. */
  byId: Map<string, string>;
  /** normalised name -> id */
  idByName: Map<string, string>;
  unreadable?: boolean;
}

export function checkLinks(
  clients: LinkClient[],
  tools: Partial<Record<LinkTool, ToolRows>>,
): LinkReport {
  const findings: LinkFinding[] = [];
  const unchecked: LinkTool[] = [];
  let sound = 0;

  for (const [tool, rows] of Object.entries(tools) as [LinkTool, ToolRows][]) {
    if (!rows || rows.unreadable) {
      unchecked.push(tool);
      continue;
    }
    /*
     * A tool whose rows carry no id cannot be checked either — Master Inbox's
     * intro-stats endpoint returns names and counts. Saying "unchecked" is
     * honest; reporting every link as stale would be alarming and wrong.
     */
    if (rows.byId.size === 0) {
      unchecked.push(tool);
      continue;
    }

    const label = LINK_TOOL_LABELS[tool];
    for (const client of clients) {
      const linked = client.links[tool] ?? null;
      const nameId = client.keys.map((k) => rows.idByName.get(k)).find(Boolean) ?? null;

      if (!linked) {
        if (nameId) {
          findings.push({
            client: client.name, tool, label, kind: "unlinked",
            detail: `Found by name as "${rows.byId.get(nameId) ?? nameId}", but no link is recorded. Recording it is what keeps this client attached through a rename.`,
          });
        }
        continue;
      }

      if (!rows.byId.has(linked)) {
        findings.push({
          client: client.name, tool, label, kind: "stale",
          detail: nameId
            ? `The recorded link points at a row that no longer exists. The name still finds "${rows.byId.get(nameId) ?? nameId}", so nothing looks broken yet — but it will when names stop being the join.`
            : "The recorded link points at a row that no longer exists, and the name finds nothing either.",
        });
        continue;
      }

      /*
       * ONE CLIENT, MANY ROWS — not a disagreement.
       *
       * Master Inbox keeps one row per PORTAL, so a client working several
       * markets owns several rows and `keys` names them all. The stored link
       * picks one; the name route finds whichever comes first. Those being
       * different ids is the NORMAL state for such a client, not drift.
       *
       * Properties & Estates is the live case: the link points at its Boston
       * portal and the name resolves to Florida. Reported as a disagreement it
       * was the consistency alerter's first-ever finding, and it was a false
       * alarm — exactly the kind that teaches people to ignore the alert.
       *
       * So a link is only wrong when it points at a row this client does NOT
       * own. Ownership is read from the tool's own index: if any of the
       * client's keys resolves to the linked id, that row is one of theirs.
       */
      const ownsLinkedRow = client.keys.some((k) => rows.idByName.get(k) === linked);

      if (nameId && nameId !== linked && !ownsLinkedRow) {
        findings.push({
          client: client.name, tool, label, kind: "disagrees",
          detail: `The link points at "${rows.byId.get(linked)}" and the name resolves to "${rows.byId.get(nameId)}", which this client does not own. One of the two is wrong about which row belongs to this client.`,
        });
        continue;
      }

      sound += 1;
    }
  }

  const rank: Record<LinkProblem, number> = { disagrees: 0, stale: 1, unlinked: 2 };
  findings.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.client.localeCompare(b.client),
  );

  return { findings, sound, unchecked };
}
