import "server-only";

import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { updateClientRow } from "@/lib/tools/client-health/clientWrites";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";
import { pushPortalStatus } from "@/lib/portals/status-push";
import type { ClientStatus } from "./client-status";
import type { OsClient } from "./os-clients";

/*
 * CHANGE ONCE -> UPDATE EVERYWHERE, for a client's status.
 *
 * The architecture spec's §10 and §21: a status is changed in one place, and
 * every system that needs to know follows. Until now the OS recorded the
 * status and told nobody, which made it a note in a table rather than a
 * decision — and in practice meant a churned client kept an open portal until
 * somebody remembered.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS LOAD-BEARING
 *
 *   1. Client Health   the status feed Master Inbox reads
 *   2. Analytics       independent, no reader downstream
 *   3. Portal nudge    makes Master Inbox re-read the feed
 *
 * The nudge must come AFTER Client Health, not with it. Master Inbox does not
 * take a status in the nudge — it re-reads the feed and reconciles from what
 * it finds. Nudging first would make it read the status we are replacing, and
 * the portal would settle on the old answer with everything reporting success.
 *
 * ---------------------------------------------------------------------------
 * THE STANDALONE TOOLS KEEP WORKING
 *
 * Nothing here replaces the Client Health -> Master Inbox push. That path
 * stays, because the tools are still used directly and will be. This adds a
 * second entry point rather than a replacement: a status set in Client Health
 * still propagates on its own, and a status set here lands in Client Health
 * and then travels the same road.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS PER-LEG, AND ALWAYS REPORTED
 *
 * The os_clients write has already committed by the time this runs. A tool
 * being down must not undo it or fail the request — but it must not be
 * silent either, or the screen would claim a propagation that never happened.
 * Every leg returns its own outcome and the caller shows them.
 */

export type PropagationTool = "client_health" | "analytics" | "portal";

export interface PropagationLeg {
  tool: PropagationTool;
  label: string;
  ok: boolean;
  /** Set when the leg did not apply — e.g. the client has no row in that tool. */
  skipped?: string;
  error?: string;
}

export interface PropagationResult {
  legs: PropagationLeg[];
  /** True when nothing failed. Skipped legs are not failures. */
  ok: boolean;
}

const LABELS: Record<PropagationTool, string> = {
  client_health: "Client Health",
  analytics: "Analytics",
  portal: "Client portal",
};

const leg = (
  tool: PropagationTool,
  over: Partial<PropagationLeg> = {},
): PropagationLeg => ({ tool, label: LABELS[tool], ok: true, ...over });

export async function propagateStatus(
  client: Pick<OsClient, "id" | "name" | "links">,
  status: ClientStatus,
): Promise<PropagationResult> {
  const legs: PropagationLeg[] = [];
  // Where this client lives in each tool, as os_clients recorded it.
  const chClientId = client.links.clientHealth;
  const anClientId = client.links.analytics;

  /* ------------------------------------------------- 1. Client Health ---- */
  let healthWritten = false;
  if (!chClientId) {
    legs.push(
      leg("client_health", {
        skipped:
          "No Client Health record is linked to this client, so there is nothing to update there.",
      }),
    );
  } else {
    try {
      const res = await updateClientRow(getClientHealthDb(), {
        id: chClientId,
        status,
      });
      if (res.ok) {
        healthWritten = true;
        legs.push(leg("client_health"));
      } else {
        legs.push(leg("client_health", { ok: false, error: res.error }));
      }
    } catch (error) {
      legs.push(
        leg("client_health", {
          ok: false,
          error: error instanceof Error ? error.message : "Client Health write failed",
        }),
      );
    }
  }

  /* ----------------------------------------------------- 2. Analytics ---- */
  if (!anClientId) {
    legs.push(
      leg("analytics", {
        skipped: "No Analytics record is linked to this client.",
      }),
    );
  } else {
    try {
      const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
      if (!secret) throw new Error("ANALYTICS_AUTH_SECRET not set");
      const token = await mintAnalyticsSession(
        secret,
        optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com",
      );
      const res = await fetch(
        `${baseUrlEnv("ANALYTICS_URL")}/api/clients/${anClientId}`,
        {
          method: "PATCH",
          // The cookie NAME matters: Analytics reads `bsa_session`, and a bare
          // token is simply an unauthenticated request. Same header the alias
          // write in edit.ts sends.
          headers: { "Content-Type": "application/json", cookie: `bsa_session=${token}` },
          body: JSON.stringify({ status }),
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) throw new Error(`Analytics returned ${res.status}`);
      legs.push(leg("analytics"));
    } catch (error) {
      legs.push(
        leg("analytics", {
          ok: false,
          error: error instanceof Error ? error.message : "Analytics write failed",
        }),
      );
    }
  }

  /* --------------------------------------------------- 3. Portal nudge --- */
  /*
   * Only worth firing when Client Health actually changed: Master Inbox
   * reconciles from that feed, so a nudge after a failed or skipped health
   * write would re-read the same answer and report a confident no-op.
   */
  if (healthWritten) {
    pushPortalStatus(`${client.name} -> ${status}`);
    legs.push(leg("portal"));
  } else {
    legs.push(
      leg("portal", {
        skipped:
          "The portal follows the Client Health status feed, which was not updated — so there is nothing new for it to read.",
      }),
    );
  }

  return { legs, ok: legs.every((l) => l.ok) };
}
