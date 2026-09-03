import type { Connector, ToolId } from "./types";
import { masterInboxConnector } from "./master-inbox";
import { clientHealthConnector } from "./client-health";
import { analyticsConnector } from "./analytics";
import { databaseConnector } from "./database";
import { scraperConnector } from "./scraper";

/*
 * THE registry. Order here is the order on screen — most-used first, black
 * boxes last, so the cards with real numbers occupy the top row.
 *
 * FOUR tools, not five. The Database app is deliberately out of scope for the
 * workspace ("we do not want database and client portals in this centralised
 * dashboard"), and the design agrees — its Products rail lists four, and the
 * home screen says "4 tools" in as many words.
 *
 * Leaving it registered meant a permanently "unconfigured" fifth card asking
 * for a DATABASE_APP_URL nobody intends to set: a piece of the screen that can
 * only ever look broken. Its connector is kept in the tree rather than deleted
 * — bringing it back is adding one line below, and the code still works.
 */
export const CONNECTORS: readonly Connector[] = [
  masterInboxConnector,
  clientHealthConnector,
  analyticsConnector,
  scraperConnector,
];

/**
 * Out of scope, kept for the day it isn't. Referenced here so the import stays
 * live and the file cannot rot silently: a compile error is a far better
 * signal than discovering it broke months after someone re-enabled it.
 */
export const OUT_OF_SCOPE_CONNECTORS: readonly Connector[] = [databaseConnector];

export const CONNECTORS_BY_ID = new Map<ToolId, Connector>(
  CONNECTORS.map((c) => [c.id, c]),
);

/** Every env var any connector reads. Feeds .env.example and diagnostics. */
export const ALL_ENV_VARS = [
  ...new Set(
    CONNECTORS.flatMap((c) => [c.baseUrlEnv, ...c.env.required, ...c.env.optional]),
  ),
].sort();
