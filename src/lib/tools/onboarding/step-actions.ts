import "server-only";

import { getOnboardingDb } from "./db";
import { hasDelivery, logDelivery, recordPendingEmail, type PendingRecord } from "./deliveries";
import { getOrchClient, nowIso } from "./orch-client";
import { searchFirmAgents, searchLeadAgents, resolveClientBrand } from "./db-agents";
import { teamFromIntake, type TfPayload } from "./typeform";
import { pushToClientPortal, pushTeamToPortal } from "./connector-portal";
import { pushToHealthDash } from "./connector-health";
import { buildBisonCampaign, launchBisonCampaign, pauseBisonCampaign } from "./connector-bison";
import { notifySlack, slackMention, esc } from "./slack";
import { DEFAULT_EXCLUDED_TITLES, withoutDnc } from "./lead-filters";

/*
 * The step actions that RUN. Ported from the tool's `app/actions.ts`:
 * pushClient, buildTeam, buildLeads, bisonBuild/Launch/Pause and the
 * post-approval chain (runSetupAutomation / retrySetup).
 *
 * Not here, by design: sending any email to a client and creating a Stripe
 * payment link. Where the chain reaches an email it records a pending-enablement
 * delivery and moves on to the next step, which is what the tool's chain does
 * with a failed email — "failures never block the rest".
 *
 * Every guard the tool has is kept: an accidental click on an already-pushed
 * client is a no-op, never a duplicate.
 */

export type ActionResult = { ok: boolean; error?: string; detail?: Record<string, unknown> };

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

/** Step 2 (+5) — push client to the Portal (also creates the intro macro) or the Health Dash. */
export async function pushClient(clientId: string, target: "client_portal" | "health_dash"): Promise<ActionResult> {
  const c = await getOrchClient(clientId);
  if (!c) return { ok: false, error: "client not found" };
  try {
    if (target === "client_portal") {
      if (!c.portal_url) await pushToClientPortal(c);
    } else if (!(await hasDelivery(clientId, "health_dash", ["onboard_client"]))) {
      await pushToHealthDash(c);
    }
    // The connector logs its own outcome; read it back so the button can say what happened.
    const { data } = await getOnboardingDb().from("orch_connector_deliveries")
      .select("status, error").eq("client_id", clientId).eq("target", target).eq("action", "onboard_client")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const last = data as { status: string; error: string | null } | null;
    if (last && last.status !== "ok") return { ok: false, error: last.error ?? `${target} push ${last.status}` };
    return { ok: true };
  } catch (e) { return fail(e); }
}

/** Step 6 — build team from public.agents by firm name + the people named in the Typeform, then push to portal. */
export async function buildTeam(clientId: string): Promise<ActionResult> {
  const c = await getOrchClient(clientId);
  if (!c) return { ok: false, error: "client not found" };
  try {
    // Team = the client's own agents, identified by FIRM name (not city — a firm spans cities).
    const firm = c.client_name || c.brand || c.office_name || "";
    const members = await searchFirmAgents({ firm });

    // Plus the intake answers: introduction contacts (the portal "Team") and the DNC list.
    const intake = (c.raw_typeform ? teamFromIntake(c.raw_typeform as TfPayload) : []).filter((p) => p.name);
    const pc = (c.primary_contact ?? {}) as { name?: string; email?: string; role?: string };
    if (pc.name && !intake.some((p) => !p.is_dnc && p.name.trim().toLowerCase() === pc.name!.trim().toLowerCase())) {
      intake.unshift({ name: pc.name, email: pc.email ?? null, role: pc.role ?? null, is_dnc: false });
    }

    const db = getOnboardingDb();
    // Replace any prior team for idempotency.
    await db.from("orch_client_team").delete().eq("client_id", clientId);
    const rows = [
      ...members.map((m) => ({
        client_id: clientId, agent_id: m.agent_id, name: m.name, email: m.email,
        phone: m.phone, role: m.role, source: "db", is_dnc: true,
      })),
      ...intake.map((p) => ({
        client_id: clientId, agent_id: null, name: p.name, email: p.email,
        phone: null, role: p.role, source: "typeform", is_dnc: p.is_dnc,
      })),
    ];
    if (rows.length) {
      const { error } = await db.from("orch_client_team").insert(rows);
      if (error) throw new Error(error.message);
      // Push the team / DNC agents into the Client Portal (re-read so portal_token is fresh).
      const withPortal = await getOrchClient(clientId);
      if (withPortal) await pushTeamToPortal(withPortal);
      await db.from("orch_clients").update({ status: "team_built", updated_at: nowIso() }).eq("id", clientId);
    }
    return { ok: true, detail: { fromDatabase: members.length, fromIntake: intake.length } };
  } catch (e) { return fail(e); }
}

/** Steps 7-10 — build the Bison lead list from public.agents (DB filters minus DNC). */
export async function buildLeads(clientId: string): Promise<ActionResult> {
  const c = await getOrchClient(clientId);
  if (!c) return { ok: false, error: "client not found" };
  try {
    const f = (c.filters ?? {}) as Record<string, number>;

    // Resolve the client's REAL brand from their own contact in the scraped data,
    // so we exclude the right brokerage — not just what they typed.
    const realBrand = await resolveClientBrand({
      email: c.primary_contact?.email, contactName: c.primary_contact?.name, location: c.location,
    });

    let leads = await searchLeadAgents({
      mls: c.mls ?? undefined, location: c.location ?? undefined,
      salesVolumeMin: f.sales_volume_min, salesVolumeMax: f.sales_volume_max,
      closedTransactionsMin: f.closed_transactions_min, closedTransactionsMax: f.closed_transactions_max,
      excludeFirms: [c.client_name].filter(Boolean) as string[],
      excludeBrands: [c.brand, realBrand].filter(Boolean) as string[],
      excludeOffices: [c.office_name].filter(Boolean) as string[],
    });

    const db = getOnboardingDb();
    // DNC names (team table: client's own agents + the Typeform exclusion list).
    const { data: dncRows } = await db.from("orch_client_team")
      .select("name").eq("client_id", clientId).eq("is_dnc", true);
    leads = withoutDnc(leads, ((dncRows ?? []) as { name: string | null }[]).map((d) => d.name ?? ""));

    await db.from("orch_client_leads").delete().eq("client_id", clientId);
    if (leads.length) {
      // Store only client_id + agent_id — the DB app joins agent_id -> public.agents for the rest.
      const { error } = await db.from("orch_client_leads").upsert(
        leads.map((l) => ({ client_id: clientId, agent_id: l.agent_id })),
        { onConflict: "client_id,agent_id" },
      );
      if (error) throw new Error(error.message);
      // leads_inreview=true hands the list to the DB app, whose UI hosts the human review.
      await db.from("orch_clients")
        .update({ status: "leads_built", leads_inreview: true, updated_at: nowIso() }).eq("id", clientId);

      // Ping the team on Slack: list is built, please review (review lives in the DB app UI).
      await notifySlack({
        clientId, action: "leads_inreview",
        text: `${slackMention()} :clipboard: Lead list built for *${esc(c.client_name ?? "Unknown client")}* — *${leads.length}* leads. Please review it in the DB app before enrichment.`,
      });
    }
    // Transparency: record what actually filtered the list (so accuracy is verifiable per client).
    await logDelivery(clientId, "db", "build_leads", "ok", {
      mls: c.mls, location: c.location,
      excluded_brands: [c.brand, realBrand].filter(Boolean),
      resolved_real_brand: realBrand, excluded_titles: DEFAULT_EXCLUDED_TITLES,
    }, { count: leads.length }, null);
    return { ok: true, detail: { count: leads.length } };
  } catch (e) { return fail(e); }
}

// ---------- Bison campaign (steps 12-15, 22, 23, 29) ----------
export async function bisonBuild(clientId: string): Promise<ActionResult> {
  const c = await getOrchClient(clientId);
  if (!c) return { ok: false, error: "client not found" };
  // Never create a second campaign by accident — the client already has one.
  if (c.bison_campaign_id) return { ok: false, error: `campaign already exists (id ${c.bison_campaign_id})` };
  const r = await buildBisonCampaign(c);
  return r.ok ? { ok: true, detail: { campaignId: r.campaignId } } : { ok: false, error: r.error };
}
export async function bisonLaunch(clientId: string): Promise<ActionResult> {
  const c = await getOrchClient(clientId);
  if (!c) return { ok: false, error: "client not found" };
  const r = await launchBisonCampaign(c);
  return r.ok ? { ok: true, detail: r.pending ? { pendingEmail: r.pending.action } : undefined } : { ok: false, error: r.error };
}
export async function bisonPause(clientId: string): Promise<ActionResult> {
  const c = await getOrchClient(clientId);
  if (!c) return { ok: false, error: "client not found" };
  try { return await pauseBisonCampaign(c); } catch (e) { return fail(e); }
}

/* --------------------------- the post-approval chain ---------------------- */

export interface ChainStep {
  name: string;
  status: "ran" | "skipped" | "failed" | "pending";
  detail?: string;
}
export interface ChainReport { steps: ChainStep[] }

/**
 * Phase 3, hands-free: once the copy is approved, run every setup push in order —
 * Portal onboard -> onboarding emails -> team/DNC -> Health Dash -> Bison campaign
 * -> lead list. Each step is skipped if already done (safe to re-run; the
 * client-page buttons stay as manual retries) and failures never block the rest.
 *
 * The onboarding emails — How Intros Work -> Meet Your Recruiting Team -> Portal
 * access -> Add your DNC — are the tool's; here each one not yet sent is
 * RECORDED AS PENDING ENABLEMENT, never sent, and the chain continues.
 */
export async function runSetupAutomation(clientId: string): Promise<ChainReport> {
  const steps: ChainStep[] = [];
  const step = async (name: string, fn: () => Promise<ChainStep["status"] | { status: ChainStep["status"]; detail?: string }>) => {
    try {
      const r = await fn();
      steps.push(typeof r === "string" ? { name, status: r } : { name, ...r });
    } catch (e) {
      console.error(`[setup-auto] ${name} failed:`, e);
      steps.push({ name, status: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  await step("portal", async () => {
    const c = await getOrchClient(clientId);
    if (!c || c.portal_url) return "skipped";
    const r = await pushClient(clientId, "client_portal");
    return r.ok ? "ran" : { status: "failed", detail: r.error };
  });
  await step("onboarding_emails", async () => {
    const c = await getOrchClient(clientId);   // re-read: portal push stores the unique link
    const pendings: PendingRecord[] = [];
    const once = async (key: string) => {
      if (!(await hasDelivery(clientId, "email", [key]))) pendings.push(await recordPendingEmail(clientId, key, { via: "setup chain" }));
    };
    await once("how_intros_work");
    await once("meet_team");
    if (c?.portal_url) { await once("portal"); await once("dnc_reminder"); }
    if (!pendings.length) return "skipped";
    return { status: "pending", detail: `not sent — pending enablement: ${pendings.map((p) => p.action).join(", ")}` };
  });
  await step("team", async () => {
    const r = await buildTeam(clientId);
    return r.ok ? "ran" : { status: "failed", detail: r.error };
  });
  await step("health_dash", async () => {
    if (await hasDelivery(clientId, "health_dash", ["onboard_client"])) return "skipped";
    const r = await pushClient(clientId, "health_dash");
    return r.ok ? "ran" : { status: "failed", detail: r.error };
  });
  await step("bison_campaign", async () => {
    const c = await getOrchClient(clientId);
    if (!c || c.bison_campaign_id) return "skipped";
    const r = await bisonBuild(clientId);
    return r.ok ? "ran" : { status: "failed", detail: r.error };
  });
  // Last: build the lead list and hand it to the DB app (flips leads_inreview + Slack ping).
  // Never rebuild once the list is with the DB app or already in the campaign.
  await step("leads", async () => {
    const c = await getOrchClient(clientId);
    if (!c || c.leads_inreview || c.bison_leads_exported) return "skipped";
    const r = await buildLeads(clientId);
    return r.ok ? "ran" : { status: "failed", detail: r.error };
  });
  return { steps };
}

/** Manual retry of the phase-3 chain — every step skips itself if already done. */
export const retrySetup = runSetupAutomation;
