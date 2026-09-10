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

/*
 * ---------------------------------------------------------------------------
 * THE SECOND TIER — for the client editor that the OS now carries
 *
 * `assertNoPortalColumns` above is the strict guard: it refuses all three
 * columns, and it is right for every screen that has no business managing
 * portals (Client Health, the roster, bulk tooling).
 *
 * It is the WRONG guard for the Master Inbox's own client editor, which the OS
 * now runs verbatim. That editor manages portals on purpose:
 *
 *   creating a client MINTS portal_token and sets portal_enabled — a new
 *   client with no portal is a broken client
 *
 *   renaming a client REWRITES slug, because slug is derived from the name
 *
 * Blocking those would not protect anything; it would delete two working
 * features. So this tier guards the narrower, sharper claim.
 *
 * WHAT ACTUALLY BREAKS A LIVE PORTAL URL
 *
 * Portals resolve by TOKEN — every route is `/portal/[token]/…` and
 * `/api/portal/[token]/…`. The slug is display metadata; the token is the
 * address. Rewriting `portal_token` on an existing client invalidates the link
 * that client already has, instantly and with no way to discover the new one.
 *
 * The user's constraint was explicit: "client portal urls remain same right for
 * all the clients?" So on an EXISTING client, the token is frozen.
 *
 * `portal_enabled` is deliberately left writable: it is the tool's own on/off
 * switch, it is reversible, and a staff member turning a portal off is making a
 * decision rather than an accident.
 */

/**
 * Guards an UPDATE to an existing client.
 *
 * Refuses only `portal_token` — the column that is the portal's URL. Everything
 * else the tool's editor writes is allowed through, because it is either
 * reversible or derived.
 *
 * Not used on INSERT: a new client must be able to mint its first token.
 */
export function assertPortalUrlStable(patch: Record<string, unknown>): void {
  if ("portal_token" in patch) throw new PortalGuardError("portal_token");
}
