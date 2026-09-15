import "server-only";

import { optionalEnv } from "@/lib/env";
import { withStandardFlags } from "@/lib/clients/portal-features";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

import { getOnboardingDb } from "./db";
import { onboardingEnv } from "./env";
import { logDelivery } from "./deliveries";
import type { OrchClient } from "./orch-client";
import { teamFromIntake, type TfPayload } from "./typeform";
import {
  dncBody, portalOnboardBody, rosterBody, teamContactBody, teamLanes, type TeamRow,
} from "./connector-payloads";

/*
 * The Client Portal connector — steps 2, 6 and 8. The tool's
 * `lib/connectors/apps.ts` (`pushToClientPortal`, `pushTeamToPortal`).
 *
 * ---------------------------------------------------------------------------
 * WHERE IT POINTS
 *
 * The "Client Portal" is Master Inbox: portal.brokerstaffer.com is that app's
 * public host, and the tool's CLIENT_PORTAL_BASE_URL + CLIENT_PORTAL_ADMIN_TOKEN
 * are its `POST /api/clients` and its service-role token. The OS already
 * creates Master Inbox clients that way for its own roster
 * (lib/clients/onboard-run.ts), so this uses the same address and the same
 * secret — MASTER_INBOX_URL with MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY — and
 * falls back to the tool's own pair under the ONBOARDING_ prefix.
 *
 * And, as onboard-run does, a freshly created portal is brought up to the
 * current feature set: Master Inbox's create route seeds three flags where
 * nine are standard. Never fatal — the portal exists and works by then.
 *
 * The team push is client-scoped (the portal token in the path, no admin
 * token), one POST per member, exactly as the tool does it.
 */

function portalEndpoint(): { base: string; token: string | null } | null {
  const base = optionalEnv("MASTER_INBOX_URL") ?? onboardingEnv("CLIENT_PORTAL_BASE_URL");
  if (!base) return null;
  const token =
    optionalEnv("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY") ??
    optionalEnv("MASTER_INBOX_ADMIN_TOKEN") ??
    onboardingEnv("CLIENT_PORTAL_ADMIN_TOKEN") ??
    null;
  return { base: base.replace(/\/+$/, ""), token };
}

const NOT_SET = "MASTER_INBOX_URL / MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY (or ONBOARDING_CLIENT_PORTAL_BASE_URL / _ADMIN_TOKEN) not set";

/** Step 2 + 5 — onboard the client into the Client Portal (creates client + intro macro). */
export async function pushToClientPortal(c: OrchClient): Promise<void> {
  const intake = c.raw_typeform ? teamFromIntake(c.raw_typeform as TfPayload) : [];
  const body = portalOnboardBody(c, intake);

  const ep = portalEndpoint();
  if (!ep || !ep.token) return logDelivery(c.id, "client_portal", "onboard_client", "skipped", body, null, NOT_SET);

  try {
    const res = await fetch(`${ep.base}/api/clients`, {
      method: "POST",
      headers: { "x-admin-token": ep.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return logDelivery(c.id, "client_portal", "onboard_client", "error", body, json, `HTTP ${res.status}`);

    // Store the portal URL/token for the "Portal Access" email link.
    const client = (json?.client ?? {}) as { id?: string; portal_url?: string; portal_token?: string };
    if (client.portal_url || client.portal_token) {
      await getOnboardingDb().from("orch_clients").update({
        portal_url: client.portal_url ?? null, portal_token: client.portal_token ?? null,
      }).eq("id", c.id);
    }

    let features: string | null = null;
    if (client.id) {
      try {
        const db = getMasterInboxSupabase();
        const { data: row } = await db.from("clients").select("feature_flags").eq("id", client.id).maybeSingle();
        const merged = withStandardFlags(row?.feature_flags);
        const { error } = await db.from("clients").update({ feature_flags: merged }).eq("id", client.id);
        if (error) throw new Error(error.message);
        features = `portal features: ${Object.keys(merged).length} flags set`;
      } catch (e) {
        features = `portal features could NOT be set (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    return logDelivery(c.id, "client_portal", "onboard_client", "ok", body, { ...(json ?? {}), os_portal_features: features }, null);
  } catch (e) {
    return logDelivery(c.id, "client_portal", "onboard_client", "error", body, null, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Step 6/8 — push the client's team / DNC agents into the Client Portal.
 * Client-scoped auth: the portal_token in the path (no admin token). One POST per member.
 */
export async function pushTeamToPortal(c: OrchClient): Promise<void> {
  const ep = portalEndpoint();
  if (!ep) return logDelivery(c.id, "client_portal", "add_team", "skipped", null, null, NOT_SET);
  if (!c.portal_token) return logDelivery(c.id, "client_portal", "add_team", "skipped", null, null, "no portal_token — push client to portal first");

  const db = getOnboardingDb();
  const { data } = await db.from("orch_client_team")
    .select("name, email, phone, role, source, is_dnc").eq("client_id", c.id);
  const team = (data ?? []) as TeamRow[];
  if (team.length === 0) return logDelivery(c.id, "client_portal", "add_team", "skipped", null, null, "no team members");

  const root = `${ep.base}/api/portal/${c.portal_token}`;

  // Names already pushed for an action — re-runs must never duplicate portal entries.
  const alreadyPushed = async (action: string) => {
    const { data: prev } = await db.from("orch_connector_deliveries")
      .select("response").eq("client_id", c.id).eq("target", "client_portal").eq("action", action);
    const set = new Set<string>();
    for (const p of (prev ?? []) as { response: { names?: unknown[] } | null }[]) {
      for (const n of p.response?.names ?? []) set.add(String(n).toLowerCase());
    }
    return set;
  };

  const push = async (action: string, members: TeamRow[], url: string, bodyFor: (m: TeamRow) => object) => {
    if (!members.length) return;
    const already = await alreadyPushed(action);
    let ok = 0; const pushedNames: string[] = []; const errors: string[] = [];
    for (const m of members) {
      if ((m.name ?? "") && already.has(String(m.name).toLowerCase())) { pushedNames.push(m.name as string); ok++; continue; }
      try {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyFor(m)),
          signal: AbortSignal.timeout(25_000),
        });
        if (res.ok) { ok++; if (m.name) pushedNames.push(m.name); }
        else errors.push(`${m.name}: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 60)}`);
      } catch (e) { errors.push(`${m.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const status = errors.length === 0 ? "ok" : ok > 0 ? "partial" : "error";
    await logDelivery(c.id, "client_portal", action, status, { count: members.length }, { pushed: ok, names: pushedNames }, errors.join("; ") || null);
  };

  const { teamContacts, roster, external } = teamLanes(team);
  await push("add_team_contacts", teamContacts, `${root}/team`, teamContactBody);
  await push("add_team", roster, `${root}/agents`, rosterBody);
  await push("add_dnc", external, `${root}/dnc`, dncBody);
}
