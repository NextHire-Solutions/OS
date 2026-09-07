import type { ToolId as GrantId } from "@/lib/bs-auth";
import type { ToolId as ConnectorId } from "@/lib/connectors/types";

/*
 * Two vocabularies for the same four tools, and the bridge between them.
 *
 *   connector ids   master-inbox · client-health · analytics · scraper
 *   grant ids       inbox        · clients       · analytics · search
 *
 * They differ because they were written for different jobs: the connector ids
 * describe the upstream service, the grant ids ride inside a signed token where
 * short and stable matters. Renaming either would be worse than mapping them —
 * connector ids appear in cached status payloads, and grant ids are baked into
 * every live session token.
 *
 * What made this worth a file: three of four tool icons silently vanished from
 * the home screen because a lookup keyed on grant ids was handed connector ids.
 * Nothing threw; the glyphs just did not render. An explicit, exhaustive map
 * turns that class of mistake into a compile error.
 */

export const GRANT_BY_CONNECTOR: Record<ConnectorId, GrantId> = {
  "master-inbox": "inbox",
  "client-health": "clients",
  analytics: "analytics",
  scraper: "search",
  onboarding: "onboarding",
};

export const CONNECTOR_BY_GRANT: Record<GrantId, ConnectorId> = {
  inbox: "master-inbox",
  clients: "client-health",
  analytics: "analytics",
  search: "scraper",
  onboarding: "onboarding",
};

export function toGrantId(id: ConnectorId): GrantId {
  return GRANT_BY_CONNECTOR[id];
}

export function toConnectorId(id: GrantId): ConnectorId {
  return CONNECTOR_BY_GRANT[id];
}
