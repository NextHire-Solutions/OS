import type { Connector, ToolId } from "./types";
import { masterInboxConnector } from "./master-inbox";
import { clientHealthConnector } from "./client-health";
import { analyticsConnector } from "./analytics";
import { databaseConnector } from "./database";
import { scraperConnector } from "./scraper";

/*
 * THE registry. Order here is the order on screen — most-used first, black
 * boxes last, so the cards with real numbers occupy the top row.
 */
export const CONNECTORS: readonly Connector[] = [
  masterInboxConnector,
  clientHealthConnector,
  analyticsConnector,
  scraperConnector,
  databaseConnector,
];

export const CONNECTORS_BY_ID = new Map<ToolId, Connector>(
  CONNECTORS.map((c) => [c.id, c]),
);

/** Every env var any connector reads. Feeds .env.example and diagnostics. */
export const ALL_ENV_VARS = [
  ...new Set(
    CONNECTORS.flatMap((c) => [c.baseUrlEnv, ...c.env.required, ...c.env.optional]),
  ),
].sort();
