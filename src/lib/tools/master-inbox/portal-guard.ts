/*
 * The four writes that would take a client portal down.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS CODE RATHER THAN A RULE
 *
 * `portal.brokerstaffer.com` serves 48 live client portals from the same
 * database this workspace now writes to. From MASTER-INBOX-AUDIT.md, a portal
 * resolves only when all of these hold:
 *
 *     clients.portal_token   matches the token in the URL
 *     clients.portal_enabled is not false
 *     clients.slug           is not 'unknown'
 *     the clients row        exists
 *
 * So exactly four writes can break one, and a staff inbox needs to do none of
 * them. A rule in a document would be followed until somebody adds a client
 * editor at 6pm; a function that throws is followed always.
 *
 * This is not defence against malice — everything here runs behind the
 * workspace sign-in. It is defence against a careless spread: one
 * `{ ...client, ...patch }` that carries `portal_token: undefined` into an
 * update is all it would take, and the failure is a client emailing to say
 * their portal link is dead.
 *
 * Deliberately NOT marked `server-only`: it is pure validation with no server
 * dependency, and marking it so would make it untestable — which for a guard
 * is the wrong trade.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* GUARDED
 *
 * Labelling a thread creates a row in the client's portal pipeline, via
 * `client_pipeline_intro_label_trigger`. That is not a leak — it is the
 * feature. The portal is supposed to show introductions as they are labelled,
 * and blocking it would break the product rather than protect it.
 */

/** Columns on `clients` that a portal's existence depends on. */
const PORTAL_COLUMNS = new Set(["portal_token", "portal_enabled", "slug"]);

export class PortalGuardError extends Error {
  readonly column: string;

  constructor(column: string) {
    super(
      `Refusing to write clients.${column} — 48 live client portals resolve on that column. ` +
        `If this is genuinely intended, it belongs in Master Inbox's own client editor, not here.`,
    );
    this.name = "PortalGuardError";
    this.column = column;
  }
}

/**
 * Throws if a patch to `clients` touches a portal-bearing column.
 *
 * Checks `in`, not truthiness: `{ portal_token: undefined }` is a spread
 * accident and would blank the column just as surely as an explicit null.
 */
export function assertNoPortalColumns(patch: Record<string, unknown>): void {
  for (const column of Object.keys(patch)) {
    if (PORTAL_COLUMNS.has(column)) throw new PortalGuardError(column);
  }
}

/**
 * Throws on any attempt to delete a client.
 *
 * Deleting cascades — it takes the portal, its pipeline, its agents and its
 * team with it — and there is no undo. The workspace has no reason to offer
 * it, so it does not.
 */
export function refuseClientDelete(): never {
  throw new PortalGuardError("row deletion");
}

/** The tables whose rows back a live portal, for anything doing bulk work. */
export const PORTAL_TABLES = [
  "clients",
  "client_agents",
  "client_dnc_entries",
  "client_pipeline_entries",
  "client_pipeline_notes",
  "client_pipeline_stages",
  "client_team_members",
] as const;
