import type { Connector, ToolId } from "./types";
import { masterInboxConnector } from "./master-inbox";
import { clientHealthConnector } from "./client-health";
import { analyticsConnector } from "./analytics";
import { scraperConnector } from "./scraper";
import { onboardingConnector } from "./onboarding";

/*
 * THE registry. Order here is the order on screen — most-used first, black
 * boxes last, so the cards with real numbers occupy the top row.
 *
 * FIVE tools. The Database app and the individual client portals are out of
 * scope for the workspace, and the design agrees: four products in the rail,
 * and "4 tools" written on the home screen.
 *
 * The Database connector was deleted rather than left dormant. A dormant
 * connector is a file nobody runs, nobody tests and nobody notices rotting;
 * git remembers it perfectly well if it is ever wanted back.
 */
export const CONNECTORS: readonly Connector[] = [
  masterInboxConnector,
  clientHealthConnector,
  analyticsConnector,
  scraperConnector,
  onboardingConnector,
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
