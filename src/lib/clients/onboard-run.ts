import "server-only";

import { osTable } from "./os-db";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";
import { withStandardFlags } from "./portal-features";
import { planOnboarding, LEGS, type Leg, type OnboardInput, type PlannedCall } from "./onboard-plan";
import { mintAnalyticsSession } from "@/lib/connectors/upstream-auth/analytics-session";
import { baseUrlEnv, optionalEnv } from "@/lib/env";
import { onboardClient } from "@/lib/tools/client-health/onboard";
import { getSupabase as getClientHealthDb } from "@/lib/tools/client-health/supabase";
import { getWeekly } from "@/lib/tools/client-health/weekly";

/*
 * Actually onboarding a client: three writes, three databases, no transaction.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THAT MAKE PARTIAL FAILURE SURVIVABLE
 *
 *   · Every leg is recorded in `os_client_onboarding` BEFORE it is attempted,
 *     and updated after. A crash between the two leaves a `running` row, which
 *     is visible, rather than a silent gap.
 *   · A leg already `done` is never re-run. The unique index on
 *     (os_client_id, leg) is what enforces that, not the caller's memory.
 *   · Legs run in a fixed order and stop at the first failure. Continuing past
 *     a failure would mint a portal for a client Client Health never accepted.
 *   · Master Inbox runs LAST and refuses to run unless both earlier legs are
 *     done, because its insert publishes a live, login-free customer URL.
 *
 * `stopBefore` exists so the irreversible leg can be held back deliberately —
 * it is how this was tested end to end without putting a portal URL into the
 * world.
 */

export interface LegResult {
  leg: Leg;
  status: "done" | "failed" | "skipped";
  httpStatus?: number;
  remoteId?: string | null;
  error?: string;
  request: Record<string, unknown>;
  response?: unknown;
}

export interface RunResult {
  osClientId: string;
  legs: LegResult[];
  /** Set only when Master Inbox ran and returned one. */
  portalUrl?: string | null;
  /**
   * What happened when the portal's feature flags were brought up to date.
   * Surfaced because a silent failure here produces a portal that works but
   * quietly lacks the tour and the newer pipeline options.
   */
  portalFeatures?: string | null;
  ok: boolean;
}

/** Where each leg's returned id is stored on `os_clients`. */
const LINK_COLUMN: Record<Leg, string> = {
  analytics: "an_client_id",
  client_health: "ch_client_id",
  master_inbox: "mi_client_id",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------------ senders */

async function send(call: PlannedCall): Promise<{ status: number; body: unknown }> {
  /*
   * Client Health is the workspace's own now. The leg used to POST to the live
   * tool's /api/clients/onboard with CLIENT_HEALTH_ONBOARDING_TOKEN; the same
   * logic — validation, duplicate guard, campaign auto-linking — lives in
   * lib/tools/client-health/onboard.ts and is called here in-process. Same
   * `{ status, body }` contract as an HTTP leg, so the run loop, the recorded
   * response and `remoteIdOf` are unchanged: 201 `{ client, linked }` on
   * success, 409 with `existing_id` on a duplicate name.
   *
   * In-process rather than a fetch to our own /api/tools route because that
   * route sits behind the workspace's session proxy, and a server process
   * has no session — and because a loopback HTTP call to yourself is a
   * dependency on your own URL for no benefit.
   */
  if (call.leg === "client_health") {
    const result = await onboardClient(getClientHealthDb(), call.body);
    if (!result.ok) {
      const { ok: _ok, status, ...body } = result;
      return { status, body };
    }
    // The 60-second read cache predates this row; drop it, as every write does.
    getWeekly.invalidate();
    return { status: 201, body: result.value };
  }

  const { url, headers } = await endpoint(call.leg, call.path);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(call.body),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function endpoint(leg: Leg, path: string): Promise<{ url: string; headers: Record<string, string> }> {
  if (leg === "analytics") {
    const secret = optionalEnv("ANALYTICS_AUTH_SECRET");
    if (!secret) throw new Error("ANALYTICS_AUTH_SECRET not set");
    const email = optionalEnv("ANALYTICS_SERVICE_EMAIL") ?? "command-center@brokerstaffer.com";
    const token = await mintAnalyticsSession(secret, email);
    return { url: baseUrlEnv("ANALYTICS_URL") + path, headers: { cookie: `bsa_session=${token}` } };
  }
  // client_health never reaches here — see send().
  const token =
    optionalEnv("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY") ?? optionalEnv("MASTER_INBOX_ADMIN_TOKEN");
  if (!token) throw new Error("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY not set");
  return { url: baseUrlEnv("MASTER_INBOX_URL") + path, headers: { "x-admin-token": token } };
}

/** The id each tool returns, dug out of its own response shape. */
function remoteIdOf(leg: Leg, body: unknown): string | null {
  const root = asRecord(body);
  if (!root) return null;
  const client = asRecord(root.client);
  const id = client?.id ?? root.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

/* --------------------------------------------------------------------- run */

export async function runOnboarding(
  osClientId: string,
  input: OnboardInput,
  { stopBefore }: { stopBefore?: Leg } = {},
): Promise<RunResult> {
  const plan = planOnboarding(input);
  if (!plan.ok) throw new Error(`Refusing to run an invalid plan: ${plan.errors.join("; ")}`);

  /*
   * Keep the introduction details on the OS record.
   *
   * They used to travel to Master Inbox, get baked into that client's reply
   * template, and be forgotten — so they could not be corrected afterwards,
   * and the composer had nothing to render an introduction from. Written
   * before the legs run, so the record is complete even if a leg fails.
   * Never fatal: an onboarding is not a failure because a role did not save.
   */
  if (input.introMacro) {
    const m = input.introMacro;
    try {
      await osTable("os_clients")
        .update({
          contact_name: m.clientFullName.trim() || null,
          contact_role: m.clientRole.trim() || null,
          contact_email: m.contactEmail?.trim() || null,
          brokerage: m.brokerage.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", osClientId);
    } catch (err) {
      console.error("[onboard] could not store the introduction details", err);
    }
  }

  const { data: existing, error: readErr } = await osTable("os_client_onboarding")
    .select("leg, status, remote_id")
    .eq("os_client_id", osClientId);
  if (readErr) throw new Error(`Could not read the onboarding record: ${readErr.message}`);
  const already = new Map(
    (existing ?? []).map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return [String(row.leg), row];
    }),
  );

  const results: LegResult[] = [];
  let featureFlagNote: string | null = null;
  let portalUrl: string | null = null;

  for (const leg of LEGS) {
    const call = plan.calls.find((c) => c.leg === leg)!;

    if (stopBefore && leg === stopBefore) {
      results.push({ leg, status: "skipped", request: call.body, error: "held back deliberately" });
      break;
    }

    const prior = already.get(leg);
    if (prior?.status === "done") {
      results.push({
        leg, status: "skipped", request: call.body,
        remoteId: (prior.remote_id as string) ?? null,
        error: "already done — never re-run",
      });
      continue;
    }

    /*
     * The gate on the irreversible leg. Checked against what has ACTUALLY
     * happened, not against what this loop did, so a resumed run cannot mint a
     * portal for a client whose earlier legs failed in an earlier attempt.
     */
    if (leg === "master_inbox") {
      const done = new Set(
        results.filter((r) => r.status === "done" || r.status === "skipped").map((r) => r.leg),
      );
      for (const [l, row] of already) if (row.status === "done") done.add(l as Leg);
      const missing = (["analytics", "client_health"] as Leg[]).filter((l) => !done.has(l));
      if (missing.length) {
        results.push({
          leg, status: "skipped", request: call.body,
          error: `refused: ${missing.join(" and ")} must succeed before a portal is created`,
        });
        break;
      }
    }

    // Record the attempt BEFORE making it.
    await osTable("os_client_onboarding").upsert(
      {
        os_client_id: osClientId, leg, status: "running",
        request: call.body, updated_at: new Date().toISOString(),
      },
      { onConflict: "os_client_id,leg" },
    );

    let result: LegResult;
    try {
      const { status, body } = await send(call);
      if (status >= 200 && status < 300) {
        const remoteId = remoteIdOf(leg, body);
        result = { leg, status: "done", httpStatus: status, remoteId, request: call.body, response: body };
        if (remoteId) {
          await osTable("os_clients")
            .update({ [LINK_COLUMN[leg]]: remoteId, updated_at: new Date().toISOString() })
            .eq("id", osClientId);
        }
        if (leg === "master_inbox") {
          const client = asRecord(asRecord(body)?.client);
          portalUrl = (client?.portal_url as string) ?? null;
          /*
           * Bring the portal up to the CURRENT feature set.
           *
           * Master Inbox's create route seeds three flags; nine are standard.
           * Six shipped after that route was written and were rolled out by
           * updating existing clients, so every client created through the API
           * since then launched without the tour, the plan display, CSV upload,
           * the source split, the integrations label or the interview stage.
           *
           * Done here rather than in Master Inbox because that app is deployed
           * and live, and this workspace must not change it. Written straight
           * to the table because its PATCH route does not accept feature_flags
           * — the same direct-write path, and the same reasoning, as the
           * Master Inbox delete in lib/clients/delete.ts.
           *
           * Never fatal: the client and its portal already exist and work by
           * this point, so a failure here is recorded and the run continues
           * rather than reporting a successful onboarding as failed.
           */
          const clientId = client?.id as string | undefined;
          if (clientId) {
            try {
              const db = getMasterInboxSupabase();
              const { data: row } = await db
                .from("clients")
                .select("feature_flags")
                .eq("id", clientId)
                .maybeSingle();
              const merged = withStandardFlags(row?.feature_flags);
              const { error } = await db
                .from("clients")
                .update({ feature_flags: merged })
                .eq("id", clientId);
              if (error) throw new Error(error.message);
              featureFlagNote = `portal features: ${Object.keys(merged).length} flags set`;
            } catch (e) {
              featureFlagNote =
                `portal features could NOT be set (${e instanceof Error ? e.message : String(e)}) — ` +
                "the portal works but is missing the tour and the newer pipeline options";
            }
          }
        }
      } else {
        const message = (asRecord(body)?.error as string) ?? `HTTP ${status}`;
        result = { leg, status: "failed", httpStatus: status, error: message, request: call.body, response: body };
      }
    } catch (e) {
      result = {
        leg, status: "failed", request: call.body,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    await osTable("os_client_onboarding").upsert(
      {
        os_client_id: osClientId, leg,
        status: result.status === "done" ? "done" : "failed",
        request: call.body,
        response: (result.response ?? null) as never,
        error: result.error ?? null,
        remote_id: result.remoteId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "os_client_id,leg" },
    );

    results.push(result);
    // Stop at the first failure: continuing would publish a portal for a
    // client the other tools never accepted.
    if (result.status === "failed") break;
  }

  return {
    osClientId,
    legs: results,
    portalUrl,
    portalFeatures: featureFlagNote,
    ok: results.every((r) => r.status !== "failed"),
  };
}
