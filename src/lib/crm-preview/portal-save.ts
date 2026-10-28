import "server-only";

import { after } from "next/server";
import { z } from "zod";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { portalBillingHold } from "@/lib/tools/master-inbox/portals/billing-hold";
import { enforceBlocklist, normalizeDomain, type BlocklistResult } from "@/lib/tools/master-inbox/portals/enforce-blocklist";
import { clientHasFeature } from "@/lib/tools/master-inbox/portals/feature-flags";
import { loadClientStageRows } from "@/lib/tools/master-inbox/portals/load-stages";
import { canonicalStageDefs, MANAGE_STAGES_FLAG, resolveStageDefs } from "@/lib/tools/master-inbox/portals/stage-config";
import { STAGE_ORDER, type PipelineStage } from "@/lib/tools/master-inbox/portals/stages-shared";
import { stopEntries } from "@/lib/tools/master-inbox/portals/stop-person";
import { resolvePortalClient, type PortalClient } from "@/lib/tools/master-inbox/portals/token";
import { notifyPortalDncBulkAdd } from "@/lib/tools/master-inbox/webhooks/slack-portal";
import { alertMarketMove, recordUse } from "@/lib/portal-usage/usage";

// The current portal's own save code (Master Inbox app/api/portal/[token]/*): the OS's copies, byte for byte.
import * as pipelineRoute from "@/app/api/tools/master-inbox/portal/[token]/pipeline/route";
import * as entryRoute from "@/app/api/tools/master-inbox/portal/[token]/pipeline/[id]/route";
import * as notesRoute from "@/app/api/tools/master-inbox/portal/[token]/pipeline/[id]/notes/route";
import * as noteRoute from "@/app/api/tools/master-inbox/portal/[token]/pipeline/[id]/notes/[noteId]/route";
import * as pushFubRoute from "@/app/api/tools/master-inbox/portal/[token]/pipeline/[id]/push-fub/route";
import * as pipelineCsvRoute from "@/app/api/tools/master-inbox/portal/[token]/pipeline/csv/route";
import * as stagesRoute from "@/app/api/tools/master-inbox/portal/[token]/stages/route";
import * as agentsRoute from "@/lib/tools/master-inbox/portal-routes/agents/route";
import * as agentRoute from "@/lib/tools/master-inbox/portal-routes/agents/id/route";
import * as agentsBulkRoute from "@/lib/tools/master-inbox/portal-routes/agents/bulk-delete/route";
import * as agentsCsvRoute from "@/lib/tools/master-inbox/portal-routes/agents/csv/route";
import * as dncRoute from "@/lib/tools/master-inbox/portal-routes/dnc/route";
import * as dncOneRoute from "@/lib/tools/master-inbox/portal-routes/dnc/id/route";
import * as dncBulkRoute from "@/lib/tools/master-inbox/portal-routes/dnc/bulk-delete/route";
import * as dncCsvRoute from "@/lib/tools/master-inbox/portal-routes/dnc/csv/route";
import * as teamRoute from "@/lib/tools/master-inbox/portal-routes/team/route";
import * as teamOneRoute from "@/lib/tools/master-inbox/portal-routes/team/id/route";
import * as teamBulkRoute from "@/lib/tools/master-inbox/portal-routes/team/bulk-delete/route";
import * as teamCsvRoute from "@/lib/tools/master-inbox/portal-routes/team/csv/route";
import * as fubRoute from "@/lib/tools/master-inbox/portal-routes/followup-boss/route";

import { demoAction, imported, introAt, saveOffer, type Db, type DemoAction, type DemoResult } from "./demo";
import { agentsByIds, emailsOf, lower, marketAction, type AgentRow, type MarketAction } from "./demo-market";
import { marketContext, matchingIds } from "./market";
import { parseMarketQuery, personKey } from "./market-model";

/*
 * A real client's save from the new portal (28 Oct — the user: "exact same functionality of the old client portals
 * for the features that are present in new client portal").
 *
 * Every save a client's current portal also has runs THAT portal's own save code — the OS's byte-identical copies of
 * Master Inbox app/api/portal/[token]/* (PORTAL-ROUTES-PARITY.md), called here in-process with the portal's token,
 * which is looked up on the server and never reaches the browser. So a save here writes the same rows and sets off
 * the same things as there: the EmailBison/Instantly blocklists, the DNC stop, the Slack posts, the Introduction
 * webhook and texts, the Follow Up Boss push.
 *
 * Before anything: the portal must be one its current portal would open (resolvePortalClient — switched on, not the
 * Unknown bucket) and not held for an unpaid invoice (billing-hold.ts), exactly as the current portal refuses.
 *
 * What the new portal adds, with no current-portal equivalent:
 *   - the Setup wizard's offer (saveOffer, one os_portal_offers row — nothing outside);
 *   - Market's "Move to" My Agents / DNC List / off every list (the user's choice, 28 Oct: "Block them by email,
 *     keep emails hidden"): the entry is saved by name (and brokerage, on the DNC List) — never the agent database's
 *     email or phone — and the agent's PREFERRED email is blocked as an added address is (on the DNC List also
 *     stopped, and kept in os_market_dnc_emails for the reply agent and the relay); at most PORTAL_MAX_MOVE agents a
 *     move, each counted as Market use. Prospects are a client's campaign leads — never added from here.
 *
 * Imports: the browser maps the file with the current portal's own mapper (portals/csv.ts) and sends the rows. A row
 * the current import would refuse is skipped and named, rather than failing the whole file; the rest go through the
 * current import, side effects and all.
 */

export const PORTAL_MAX_MOVE = 500;
/* What an entry Market made says in its notes — how a later move knows it is Market's own to take off. */
const FROM_MARKET = "From Market";
/* The address a Market move blocks, stops and keeps: the agent's preferred email only (the user, 28 Oct). */
const preferredOf = (ag: AgentRow): string[] => (lower(ag.preferred_email) ? [lower(ag.preferred_email)] : []);

/* A table the database does not have — PostgREST's own codes for it, nothing broader (a permission refusal is not "missing"). */
export const tableMissing = (e: { code?: string } | null | undefined) => !!e && (e.code === "PGRST205" || e.code === "42P01");

/*
 * The hidden addresses (os_market_dnc_emails, migration 0044), each once — looked up 200 entries at a time (a longer id
 * list passes the gateway's URL limit). Before the migration is run the table is not there: the move goes ahead as
 * before (the providers' blocklists and the stop still happen) and the gap is logged. True when they could not be kept.
 */
async function keepHidden(rows: Array<{ entry_id: string; client_id: string; email: string; added_by: string }>): Promise<boolean> {
  if (!rows.length) return false;
  const db = createAdminSupabase() as unknown as Db;
  const ids = [...new Set(rows.map((r) => r.entry_id))];
  const kept = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const have = await db.from("os_market_dnc_emails").select("entry_id, email").in("entry_id", ids.slice(i, i + 200));
    if (tableMissing(have.error)) {
      console.warn(JSON.stringify({ tag: "[crm-preview] market dnc", warning: "os_market_dnc_emails is not there yet (migration 0044) — the reply agent will not see these addresses", rows: rows.length }));
      return false;
    }
    if (have.error) return true;
    for (const r of (have.data ?? []) as Array<{ entry_id: string; email: string }>) kept.add(`${r.entry_id}|${r.email}`);
  }
  const fresh = rows.filter((r, i) => !kept.has(`${r.entry_id}|${r.email}`) && rows.findIndex((x) => x.entry_id === r.entry_id && x.email === r.email) === i);
  for (let i = 0; i < fresh.length; i += 500) {
    const ins = await db.from("os_market_dnc_emails").insert(fresh.slice(i, i + 500));
    if (ins.error && !tableMissing(ins.error)) return true;
  }
  return false;
}

/* The new portal's own saves, beyond the Demo's list. */
const fubAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fub.connect"), api_key: z.string().trim().min(8, "That doesn't look like a Follow Up Boss API key.").max(200) }),
  z.object({ type: z.literal("fub.disconnect") }),
]);
type FubAction = z.infer<typeof fubAction>;

type Res = { status: number; json: Record<string, unknown> };
type Ctx<P> = { params: Promise<P> };
// (The note routes' types allow no answer, though each path answers; none is read as a failure.)
type Handler<P> = (request: Request, context: Ctx<P>) => Promise<Response | undefined>;

/** Calls one of the current portal's handlers as its route would be called — JSON in, status and JSON out. */
async function call<P extends { token: string }>(handler: Handler<P>, method: string, params: P, body?: unknown): Promise<Res> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await handler(new Request("http://portal.internal/save", init), { params: Promise.resolve(params) });
  if (!res) return { status: 500, json: {} };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

const UNAVAILABLE = "This portal isn't available right now. Please contact BrokerStaffer.";
const TRY_AGAIN = "That could not be saved. Please try again.";

/* A handler's refusal, in the portal's words: its own sentence where it wrote one for people, never a database error. */
function refusal(r: Res): DemoResult {
  const raw = typeof r.json.error === "string" ? r.json.error.trim() : "";
  const status: 400 | 404 | 409 = r.status === 404 ? 404 : r.status === 409 ? 409 : 400;
  if (raw === "Portal not found") return { ok: false, status: 404, error: UNAVAILABLE };
  if (/duplicate key|already exists|23505/i.test(raw)) return { ok: false, status: 409, error: "That's already on the list." };
  if (!raw || r.status >= 500 || /violates|constraint|column|relation|syntax|PGRST|fetch failed|JSON/i.test(raw)) return { ok: false, status, error: TRY_AGAIN };
  return { ok: false, status, error: raw };
}

const ok = (r: Res) => r.status >= 200 && r.status < 300;
const idOf = (r: Res): string | undefined => (typeof r.json.id === "string" ? r.json.id : undefined);

/* Id lists go in parts the database gateway's URL limit allows (demo.ts eachChunk: about 400 ids). */
async function inParts(ids: readonly string[], send: (part: string[]) => Promise<Res>): Promise<DemoResult> {
  for (let i = 0; i < ids.length; i += 200) {
    const r = await send(ids.slice(i, i + 200));
    if (!ok(r)) return refusal(r);
  }
  return { ok: true };
}

type Portal = { client: PortalClient; token: string };

/* What the current portal's DNC add says: whether the providers took the address or domain (dnc-list.tsx). */
function pushedMessage(r: Res, blocks: boolean): string {
  if (!blocks) return "Added";
  return r.json.pushedInstantly || r.json.pushedEmailBison ? "Added · pushed to provider blocklists" : "Added · provider push pending";
}

/*
 * The address as stored when only its case differs from what was sent: the current portal compares addresses exactly,
 * so a re-cased one (the form lowercases) would be blocked and stopped again, and the stored one rewritten (28 Oct audit).
 */
async function keepCase(table: "client_agents" | "client_dnc_entries" | "client_pipeline_entries" | "client_team_members", column: "email" | "lead_email", clientId: string, id: string, sent: string | null): Promise<string | null> {
  if (!sent) return sent;
  const { data } = await (createAdminSupabase() as unknown as Db).from(table).select(column).eq("client_id", clientId).eq("id", id).maybeSingle();
  const stored = (data as Record<string, string | null> | null)?.[column] ?? null;
  return stored && stored.toLowerCase() === sent.toLowerCase() ? stored : sent;
}

/** The portal as its current portal sees it — null when that would not open it (or the token is not there). */
async function openPortal(portalId: string): Promise<Portal | null> {
  const { data, error } = await createAdminSupabase().from("clients").select("portal_token").eq("id", portalId).maybeSingle();
  if (error) throw new Error(`clients: ${error.message}`);
  const token = (data as { portal_token: string | null } | null)?.portal_token;
  if (!token) return null;
  const client = await resolvePortalClient(token);
  return client && client.id === portalId ? { client, token } : null;
}

/**
 * One save on a real client's portal. The viewer was checked by the route (viewer-rules mayWritePortal): the
 * portal's own signed-in client, or staff (29 Oct). `who` is that person, from the server; `role` how their use is
 * counted (portal-usage: staff are counted, never alerted on).
 */
export async function runPortalAction(portalId: string, action: unknown, who: string, role: "client" | "staff" = "client"): Promise<DemoResult> {
  const market = marketAction.safeParse(action);
  const fub = market.success ? null : fubAction.safeParse(action);
  const parsed = market.success || fub?.success ? null : demoAction.safeParse(action);
  if (!market.success && !fub?.success && !parsed?.success) return { ok: false, status: 400, error: parsed?.error?.issues[0]?.message ?? "That could not be saved." };

  const portal = await openPortal(portalId);
  if (!portal) return { ok: false, status: 404, error: UNAVAILABLE };
  // Held for an unpaid invoice: nothing changes, as the current portal (which shows only the notice).
  if (await portalBillingHold(portal.client.id)) return { ok: false, status: 409, error: "Your portal is paused while an invoice is unpaid. Please contact BrokerStaffer." };

  if (market.success) return moveAgents(portal, market.data, who, role);
  if (fub?.success) return followUpBoss(portal, fub.data);
  return save(portal, parsed!.data!, who);
}

async function followUpBoss({ token }: Portal, a: FubAction): Promise<DemoResult> {
  if (a.type === "fub.disconnect") {
    const r = await call(fubRoute.DELETE, "DELETE", { token });
    return ok(r) ? { ok: true, message: "Follow Up Boss is disconnected." } : refusal(r);
  }
  const r = await call(fubRoute.PATCH, "PATCH", { token }, { apiKey: a.api_key });
  if (!ok(r)) return refusal(r);
  const account = (r.json.account ?? null) as { name?: unknown } | null;
  const name = account && typeof account.name === "string" && account.name.trim() ? account.name.trim() : null;
  return { ok: true, message: name ? `Connected to Follow Up Boss (${name}).` : "Connected to Follow Up Boss." };
}

async function save(portal: Portal, a: DemoAction, who: string): Promise<DemoResult> {
  const { client, token } = portal;
  const T = { token };
  switch (a.type) {
    case "offer.save":
      return saveOffer(createAdminSupabase(), client.id, a, who);

    // ------------------------------------------------------------ pipeline ---
    case "entry.add": {
      const r = await call(pipelineRoute.POST, "POST", T, {
        lead_name: a.lead_name,
        lead_email: a.lead_email,
        lead_phone: a.lead_phone,
        current_brokerage: a.current_brokerage,
        agent_profile_url: a.agent_profile_url,
        ...(a.stage ? { stage: a.stage } : {}),
        // As the current portal's Add: the chosen day at noon UTC (else today), and the replacement mark.
        ...(a.introduced_at ? { introduced_at: introAt(a.introduced_at) } : {}),
        needs_replacement: a.needs_replacement ?? false,
      });
      return ok(r) ? { ok: true, id: idOf(r) } : refusal(r);
    }
    case "entry.stage": {
      // One agent: the single save the agent's own stage menu makes; several: the bulk move. Both announce as live.
      if (a.ids.length === 1) {
        const r = await call(entryRoute.PATCH, "PATCH", { token, id: a.ids[0] }, { stage: a.stage });
        return ok(r) ? { ok: true } : refusal(r);
      }
      const moved = await inParts(a.ids, (ids) => call(pipelineRoute.PATCH, "PATCH", T, { action: "stage", ids, stage: a.stage }));
      // With Manage stages a move also takes the agent out of a custom stage, as the single move does (the current
      // bulk move leaves it there, so the agent would stay in that column — its own portal's known gap).
      if (moved.ok && clientHasFeature(client, MANAGE_STAGES_FLAG)) {
        const db = createAdminSupabase();
        for (let i = 0; i < a.ids.length; i += 200) {
          const { error } = await db.from("client_pipeline_entries").update({ custom_stage_key: null }).eq("client_id", client.id).in("id", a.ids.slice(i, i + 200)).not("custom_stage_key", "is", null);
          if (error) return { ok: false, status: 400, error: TRY_AGAIN };
        }
      }
      return moved;
    }
    case "entry.customStage": {
      // A custom stage is the Manage-stages flag's (the current portal ignores it otherwise — and would say "saved").
      if (!clientHasFeature(client, MANAGE_STAGES_FLAG)) return { ok: false, status: 400, error: "Custom stages aren't turned on for your portal." };
      for (const id of a.ids) {
        const r = await call(entryRoute.PATCH, "PATCH", { token, id }, { custom_stage_key: a.key });
        if (!ok(r)) return refusal(r);
      }
      return { ok: true };
    }
    case "entry.assign": {
      // The member must be on this portal's team (the current routes leave that to the database; checked here first).
      if (a.member) {
        const m = await createAdminSupabase().from("client_team_members").select("id").eq("client_id", client.id).eq("id", a.member).maybeSingle();
        if (m.error) return { ok: false, status: 400, error: TRY_AGAIN };
        if (!m.data) return { ok: false, status: 404, error: "That team member is not on this portal." };
      }
      if (a.ids.length === 1) {
        const r = await call(entryRoute.PATCH, "PATCH", { token, id: a.ids[0] }, { assigned_team_member_id: a.member });
        return ok(r) ? { ok: true } : refusal(r);
      }
      return inParts(a.ids, (ids) => call(pipelineRoute.PATCH, "PATCH", T, { action: "assign", ids, assigned_team_member_id: a.member }));
    }
    case "entry.edit": {
      const r = await call(entryRoute.PATCH, "PATCH", { token, id: a.id }, {
        lead_name: a.lead_name,
        lead_email: await keepCase("client_pipeline_entries", "lead_email", client.id, a.id, a.lead_email),
        lead_phone: a.lead_phone,
        current_brokerage: a.current_brokerage,
        agent_profile_url: a.agent_profile_url,
        ...(a.introduced_at ? { introduced_at: introAt(a.introduced_at) } : {}),
        ...(a.needs_replacement !== undefined ? { needs_replacement: a.needs_replacement } : {}),
      });
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "entry.fields": {
      // As the current portal: a value (a blank one too — it blanks the field) is set; null takes the client's own field off.
      const set: Record<string, string> = {};
      const remove: string[] = [];
      for (const [key, value] of Object.entries(a.fields)) {
        if (value === null) remove.push(key);
        else set[key] = value;
      }
      const r = await call(entryRoute.PATCH, "PATCH", { token, id: a.id }, {
        ...(Object.keys(set).length ? { custom_fields: set } : {}),
        ...(remove.length ? { custom_fields_remove: remove } : {}),
      });
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "entry.delete": {
      if (a.ids.length === 1) {
        const r = await call(entryRoute.DELETE, "DELETE", { token, id: a.ids[0] });
        return ok(r) ? { ok: true } : refusal(r);
      }
      return inParts(a.ids, (ids) => call(pipelineRoute.PATCH, "PATCH", T, { action: "delete", ids }));
    }
    case "note.add": {
      const r = await call(notesRoute.POST, "POST", { token, id: a.entry }, { body: a.body });
      if (!ok(r)) return r.status === 404 && r.json.error === "Entry not found" ? { ok: false, status: 404, error: "That agent is not on this portal." } : refusal(r);
      const note = r.json.note as { id?: unknown } | undefined;
      return { ok: true, id: typeof note?.id === "string" ? note.id : undefined };
    }
    case "note.edit":
    case "note.delete": {
      const at = { token, id: a.entry, noteId: a.note };
      const r = a.type === "note.edit" ? await call(noteRoute.PATCH, "PATCH", at, { body: a.body }) : await call(noteRoute.DELETE, "DELETE", at);
      if (r.status === 404 && r.json.error === "Note not found") return { ok: false, status: 404, error: "That note is no longer there." };
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "entry.push": {
      // The current portal's "Push to FUB" — its own words for why not (not connected, no email or phone, Follow Up Boss's error).
      const r = await call(pushFubRoute.POST, "POST", { token, id: a.id });
      if (!ok(r)) return { ok: false, status: r.status === 404 ? 404 : 400, error: typeof r.json.error === "string" && r.json.error !== "Portal not found" ? r.json.error : UNAVAILABLE };
      return { ok: true, message: r.json.mode === "created" ? "Sent to Follow Up Boss." : "Updated in Follow Up Boss." };
    }
    case "stages.save": {
      const r = await call(stagesRoute.PATCH, "PATCH", T, { stages: a.stages });
      if (r.status === 404 && r.json.error === "Not found") return { ok: false, status: 400, error: "Managing stages isn't turned on for your portal." };
      return ok(r) ? { ok: true, message: "Saved." } : refusal(r);
    }

    // ----------------------------------------------------------- My Agents ---
    case "agent.add": {
      const r = await call(agentsRoute.POST, "POST", T, { name: a.name, email: a.email, phone: a.phone, license: a.license });
      return ok(r) ? { ok: true, id: idOf(r), message: "Agent added" } : refusal(r);
    }
    case "agent.edit": {
      const email = await keepCase("client_agents", "email", client.id, a.id, a.email);
      const r = await call(agentRoute.PATCH, "PATCH", { token, id: a.id }, { name: a.name, email, phone: a.phone, license: a.license });
      if (r.status === 404 && r.json.error !== "Portal not found") return { ok: false, status: 404, error: "That agent is not on this portal." };
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "agent.delete": {
      if (a.ids.length === 1 && !a.bulk) {
        const r = await call(agentRoute.DELETE, "DELETE", { token, id: a.ids[0] });
        return ok(r) ? { ok: true } : refusal(r);
      }
      return inParts(a.ids, (ids) => call(agentsBulkRoute.POST, "POST", T, { ids }));
    }

    // ------------------------------------------------------------ DNC List ---
    case "dnc.add": {
      const domain = a.kind === "company" && a.domain ? normalizeDomain(a.domain) : null;
      // A company's domain is what it blocks: one that can't be read is said so, not saved blocking nothing.
      if (a.kind === "company" && a.domain && !domain) return { ok: false, status: 400, error: "That doesn't look like a website domain (for example kw.com)." };
      const r = await call(dncRoute.POST, "POST", T, {
        kind: a.kind,
        name: a.name,
        email: a.email,
        phone: a.phone,
        brokerage: a.kind === "agent" ? a.brokerage : null,
        domain: a.kind === "company" ? domain : null,
        notes: a.notes,
      });
      return ok(r) ? { ok: true, id: idOf(r), message: pushedMessage(r, !!(a.kind === "company" ? domain : a.email)) } : refusal(r);
    }
    case "dnc.edit": {
      const cur = await createAdminSupabase().from("client_dnc_entries").select("kind, email").eq("client_id", client.id).eq("id", a.id).maybeSingle();
      if (cur.error) return { ok: false, status: 400, error: TRY_AGAIN };
      if (!cur.data) return { ok: false, status: 404, error: "That entry is not on this portal." };
      const company = (cur.data as { kind: string }).kind !== "agent";
      const domain = company && a.domain ? normalizeDomain(a.domain) : null;
      if (company && a.domain && !domain) return { ok: false, status: 400, error: "That doesn't look like a website domain (for example kw.com)." };
      // A company's form has name, domain and notes; an agent's has no domain. What a form doesn't show stays as it is.
      const stored = (cur.data as { email: string | null }).email;
      const email = stored && a.email && stored.toLowerCase() === a.email.toLowerCase() ? stored : a.email;
      const body = company ? { name: a.name, domain, notes: a.notes } : { name: a.name, email, phone: a.phone, brokerage: a.brokerage, notes: a.notes };
      const r = await call(dncOneRoute.PATCH, "PATCH", { token, id: a.id }, body);
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "dnc.delete": {
      if (a.ids.length === 1 && !a.bulk) {
        const r = await call(dncOneRoute.DELETE, "DELETE", { token, id: a.ids[0] });
        return ok(r) ? { ok: true } : refusal(r);
      }
      return inParts(a.ids, (ids) => call(dncBulkRoute.POST, "POST", T, { ids }));
    }

    // ---------------------------------------------------------------- Team ---
    case "team.add": {
      const r = await call(teamRoute.POST, "POST", T, { name: a.name, email: a.email, title: a.title, phone: a.phone });
      return ok(r) ? { ok: true, id: idOf(r) } : refusal(r);
    }
    case "team.edit": {
      const email = await keepCase("client_team_members", "email", client.id, a.id, a.email);
      const r = await call(teamOneRoute.PATCH, "PATCH", { token, id: a.id }, { name: a.name, email, title: a.title, phone: a.phone });
      if (r.status === 404 && r.json.error !== "Portal not found") return { ok: false, status: 404, error: "That person is not on this portal's team." };
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "team.active": {
      const r = await call(teamOneRoute.PATCH, "PATCH", { token, id: a.id }, { active: a.active });
      if (r.status === 404 && r.json.error !== "Portal not found") return { ok: false, status: 404, error: "That person is not on this portal's team." };
      return ok(r) ? { ok: true } : refusal(r);
    }
    case "team.delete": {
      if (a.ids.length === 1 && !a.bulk) {
        const r = await call(teamOneRoute.DELETE, "DELETE", { token, id: a.ids[0] });
        return ok(r) ? { ok: true } : refusal(r);
      }
      return inParts(a.ids, (ids) => call(teamBulkRoute.POST, "POST", T, { ids }));
    }

    // ------------------------------------------------------------- imports ---
    case "entry.import":
    case "agent.import":
    case "dnc.import":
    case "team.import":
      return importRows(portal, a);
  }
}

/* ------------------------------------------------------------------ imports --- */

type CsvIn = Record<string, string | boolean | null> | null;
type Skip = { row: number; reason: string };
const EMAIL = z.string().email();
// The current pipeline import's own email check (pipeline/csv/route.ts).
const PIPELINE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* One row's fields, trimmed and bounded as the current routes bound them; the first problem names why it is skipped. */
function rowReader(raw: CsvIn) {
  const problems: string[] = [];
  const get = (key: string, max: number, what: string): string | null => {
    const v = raw && typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (!v) return null;
    if (v.length > max) {
      problems.push(`${what} is longer than ${max} characters`);
      return null;
    }
    return v;
  };
  const email = (key: string, max: number, check: (v: string) => boolean = (v) => EMAIL.safeParse(v).success): string | null => {
    const v = get(key, max, "the email");
    if (v && !check(v)) {
      problems.push(`"${v.slice(0, 60)}" is not a valid email`);
      return null;
    }
    return v;
  };
  return { get, email, problems, flag: (key: string) => raw?.[key] === true };
}

/* "We/They Rejected" → "we_they_rejected", as demo.ts compares stage names. */
const stageWord = (s: string) => s.trim().toLowerCase().replace(/[\s/-]+/g, "_");

/* A stage as a file may write it — its key, its default name or this portal's own name for it — as the current import's key; null: not one of its pipeline stages. */
async function stageReader(client: PortalClient): Promise<(raw: string) => PipelineStage | null> {
  const stageClient = { feature_flags: client.feature_flags, stage_label_overrides: client.stage_label_overrides };
  const defs = clientHasFeature(client, MANAGE_STAGES_FLAG) ? resolveStageDefs(stageClient, await loadClientStageRows(client.id)) : canonicalStageDefs(stageClient);
  const own = new Map<string, PipelineStage>();
  for (const d of defs) if (d.kind === "canonical" && d.canonicalStage) own.set(stageWord(d.label), d.canonicalStage);
  return (raw) => {
    const word = stageWord(raw);
    if ((STAGE_ORDER as string[]).includes(word)) return word as PipelineStage;
    return own.get(word) ?? null;
  };
}

async function importRows({ client, token }: Portal, a: Extract<DemoAction, { rows: unknown }>): Promise<DemoResult> {
  const T = { token };
  const rowNo = (i: number) => a.lines?.[i] ?? i + 2;
  const skipped: Skip[] = [];
  // Each row sent, with its line in the file — the current import counts only what it is sent.
  const sent: Array<{ line: number; row: Record<string, unknown> }> = [];
  const keep = (i: number, f: ReturnType<typeof rowReader>, row: Record<string, unknown>) => {
    if (f.problems.length) skipped.push({ row: rowNo(i), reason: f.problems[0] });
    else sent.push({ line: rowNo(i), row });
  };

  switch (a.type) {
    case "agent.import": {
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("name", 160, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        keep(i, f, { name, email: f.email("email", 320), phone: f.get("phone", 40, "the phone"), license: f.get("license", 80, "the license") });
      });
      if (!sent.length) return imported(0, 0, skipped, ["agent", "agents"]);
      const r = await call(agentsCsvRoute.POST, "POST", T, { rows: sent.map((s) => s.row) });
      if (!ok(r)) return refusal(r);
      const saved = Number(r.json.inserted ?? 0);
      // Already on My Agents, or twice in the file (by email): the current import leaves them out.
      return imported(saved, Math.max(0, sent.length - saved), skipped, ["agent", "agents"]);
    }
    case "dnc.import": {
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("name", 160, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        const kind = raw?.kind === "company" ? "company" : "agent";
        const domainText = kind === "company" ? f.get("domain", 255, "the domain") : null;
        const domain = domainText ? normalizeDomain(domainText) : null;
        if (domainText && !domain) f.problems.push(`"${domainText.slice(0, 60)}" is not a website domain`);
        keep(i, f, {
          kind,
          name,
          email: f.email("email", 320),
          phone: f.get("phone", 40, "the phone"),
          brokerage: kind === "agent" ? f.get("brokerage", 160, "the brokerage") : null,
          domain,
          notes: f.get("notes", 2000, "the notes"),
        });
      });
      if (!sent.length) return imported(0, 0, skipped, ["entry", "entries"]);
      const r = await call(dncCsvRoute.POST, "POST", T, { rows: sent.map((s) => s.row) });
      if (!ok(r)) return refusal(r);
      const saved = Number(r.json.inserted ?? 0);
      return imported(saved, Math.max(0, sent.length - saved), skipped, ["entry", "entries"]);
    }
    case "team.import": {
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("name", 120, "the name");
        const email = f.email("email", 160);
        const title = f.get("title", 120, "the title");
        const phone = f.get("phone", 40, "the phone");
        if (f.problems.length) return void skipped.push({ row: rowNo(i), reason: f.problems[0] });
        if (!name || !email) return void skipped.push({ row: rowNo(i), reason: "needs a name and an email" });
        sent.push({ line: rowNo(i), row: { name, email, title, phone } });
      });
      if (!sent.length) return imported(0, 0, skipped, ["team member", "team members"]);
      const r = await call(teamCsvRoute.POST, "POST", T, { rows: sent.map((s) => s.row) });
      if (!ok(r)) return refusal(r);
      const saved = Number(r.json.inserted ?? 0);
      // Already on the team (same name and email), or twice in the file.
      return imported(saved, Math.max(0, sent.length - saved), skipped, ["team member", "team members"]);
    }
    case "entry.import": {
      // Importing a file into the pipeline is the pipeline_csv_upload flag's, as in the current portal.
      if (!clientHasFeature(client, "pipeline_csv_upload")) return { ok: false, status: 400, error: "Importing a file into the pipeline isn't turned on for your portal. Please contact BrokerStaffer." };
      const stageOf = await stageReader(client);
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("lead_name", 200, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        const lead_email = f.email("lead_email", 200, (v) => PIPELINE_EMAIL.test(v));
        const stageText = f.get("stage", 64, "the stage");
        const stage = stageText ? stageOf(stageText) : "introduction";
        if (!stage) f.problems.push(`"${stageText!.slice(0, 40)}" is not one of your pipeline stages`);
        const dateText = f.get("introduced_at", 64, "the date");
        const parsed = dateText ? new Date(dateText) : null;
        // A real calendar date only (a spreadsheet's date number reads as the year 45212, which the database refuses — failing the whole file).
        const date = parsed && !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 1900 && parsed.getUTCFullYear() <= 2100 ? parsed : null;
        if (dateText && !date) f.problems.push(`"${dateText.slice(0, 40)}" is not a date (use a date like 2026-10-01)`);
        keep(i, f, {
          lead_name: name,
          lead_email,
          lead_phone: f.get("lead_phone", 80, "the phone"),
          current_brokerage: f.get("current_brokerage", 200, "the brokerage"),
          agent_profile_url: f.get("agent_profile_url", 500, "the profile link"),
          introduced_at: date ? date.toISOString() : null,
          stage,
          needs_replacement: f.flag("needs_replacement"),
        });
      });
      if (!sent.length) return imported(0, 0, skipped, ["agent", "agents"]);
      const r = await call(pipelineCsvRoute.POST, "POST", T, { rows: sent.map((s) => s.row) });
      if (r.status === 404 && r.json.error === "Not found") return { ok: false, status: 400, error: "Importing a file into the pipeline isn't turned on for your portal. Please contact BrokerStaffer." };
      if (!ok(r)) return refusal(r);
      // Its own skips count the rows it was sent from 1.
      for (const s of (Array.isArray(r.json.skipped) ? r.json.skipped : []) as Array<{ row?: unknown; reason?: unknown }>) {
        const at = typeof s.row === "number" ? sent[s.row - 1]?.line : undefined;
        skipped.push({ row: at ?? 0, reason: typeof s.reason === "string" ? s.reason : "could not be read" });
      }
      skipped.sort((x, y) => x.row - y.row);
      return imported(Number(r.json.inserted ?? 0), 0, skipped, ["agent", "agents"]);
    }
  }
}

/* --------------------------------------------------- Market's Move to (28 Oct) --- */

const DB_CONCURRENCY = 10;

/**
 * Each email onto the blocklists, as an added address is (enforceBlocklist — once each); then each row just added says
 * how its own went. `rest`: emails of agents already on the list, blocked too, no row to note it on.
 */
async function blockAll(table: "client_agents" | "client_dnc_entries", rows: Array<{ id: string; emails: string[] }>, rest: readonly string[]): Promise<void> {
  const db = createAdminSupabase();
  const done = new Map<string, BlocklistResult>();
  const all = [...new Set([...rows.flatMap((r) => r.emails), ...rest])];
  for (let i = 0; i < all.length; i += DB_CONCURRENCY) {
    await Promise.allSettled(all.slice(i, i + DB_CONCURRENCY).map(async (email) => done.set(email, await enforceBlocklist(email))));
  }
  for (let i = 0; i < rows.length; i += DB_CONCURRENCY) {
    await Promise.allSettled(
      rows.slice(i, i + DB_CONCURRENCY).map(async (row) => {
        const results = row.emails.map((e) => done.get(e)).filter((x): x is BlocklistResult => !!x);
        if (!results.length) return;
        await db
          .from(table)
          .update({
            pushed_to_instantly: results.every((x) => x.pushedInstantly),
            pushed_to_emailbison: results.every((x) => x.pushedEmailBison),
            push_error: results.find((x) => x.error)?.error ?? null,
          })
          .eq("id", row.id);
      }),
    );
  }
}

/**
 * Moves agents of the agent database between a real portal's lists — as demo.ts moveAgents does on the Demo, with
 * the current portal's side effects for what a list means: on My Agents or the DNC List, never emailed (each of the
 * agent's database emails blocked, as an added address is); on the DNC List, also stopped and posted to Slack (as an
 * imported DNC file is). The agent's email is never written onto the list.
 */
async function moveAgents({ client, token }: Portal, a: MarketAction, who: string, role: "client" | "staff"): Promise<DemoResult> {
  const C = client.id;
  if (a.to === "Prospects") return { ok: false, status: 400, error: "Prospects are the leads in your campaigns — agents aren't added to them from here." };
  let ids: string[];
  if (a.type === "market.move") {
    if (a.ids.length > PORTAL_MAX_MOVE) return { ok: false, status: 409, error: `That's ${a.ids.length.toLocaleString("en-US")} agents — move ${PORTAL_MAX_MOVE.toLocaleString("en-US")} or fewer at once.` };
    ids = a.ids;
  } else {
    const ctx = await marketContext(C);
    if (!ctx) return { ok: false, status: 404, error: UNAVAILABLE };
    const found = await matchingIds(ctx, { ...parseMarketQuery(new URLSearchParams(a.query)), list: a.list }, PORTAL_MAX_MOVE);
    if ("unavailable" in found) return { ok: false, status: 409, error: found.unavailable };
    if (found.total > PORTAL_MAX_MOVE) {
      return { ok: false, status: 409, error: `That's ${found.total.toLocaleString("en-US")} agents — narrow the filters to ${PORTAL_MAX_MOVE.toLocaleString("en-US")} or fewer to move them all at once.` };
    }
    if (!found.ids.length) return { ok: false, status: 404, error: "No agents match these filters." };
    ids = found.ids;
  }

  let agents = await agentsByIds([...new Set(ids)]);
  if (!agents.length) return { ok: false, status: 404, error: "Those agents are not in the agent database." };

  // Every row of the portal's lists (a real client's can be thousands — every page of them).
  const db = createAdminSupabase();
  const all = <T,>(table: string, columns: string) => fetchAllRows<T>(({ from, to }) => (db as unknown as Db).from(table).select(columns).eq("client_id", C).order("id").range(from, to));
  const [mine, dnc, pipeline] = await Promise.all([
    all<{ id: string; name: string | null; email: string | null; notes: string | null }>("client_agents", "id, name, email, notes"),
    all<{ id: string; kind: string; name: string | null; email: string | null; domain: string | null; notes: string | null }>("client_dnc_entries", "id, kind, name, email, domain, notes"),
    a.onlyUnlisted ? all<{ id: string; lead_name: string | null; lead_email: string | null }>("client_pipeline_entries", "id, lead_name, lead_email") : Promise.resolve([]),
  ]);

  if (a.onlyUnlisted) {
    const people = [
      ...mine,
      ...dnc.filter((d) => d.kind === "agent"),
      ...pipeline.map((x) => ({ name: x.lead_name, email: x.lead_email })),
    ];
    const listedEmails = new Set(people.map((x) => lower(x.email)).filter(Boolean));
    const listedNames = new Set(people.filter((x) => !lower(x.email)).map((x) => personKey(x.name)).filter((k) => k.length >= 5));
    const domains = new Set(dnc.filter((d) => d.kind === "company").map((d) => lower(d.domain).replace(/^@/, "")).filter(Boolean));
    agents = agents.filter((ag) => !emailsOf(ag).some((e) => listedEmails.has(e) || domains.has(e.split("@")[1] ?? "")) && !listedNames.has(personKey(ag.full_name)));
    if (!agents.length) return { ok: true, message: "They're all on My Agents, your DNC List or your pipeline already — left out, as always." };
  }

  // An agent is recognised on a list by its PREFERRED address (or, where an entry has none, by name): the enriched one is
  // a guess that may be someone else's, so it never takes a different person's entry off a list, nor counts as one
  // already there (28 Oct audit).
  const emails = new Set(agents.flatMap(preferredOf));
  const names = new Set(agents.map((ag) => personKey(ag.full_name)).filter((k) => k.length >= 5));
  // Already on the list it goes to — not added twice: by that address, or by name where the entry has none (market-model listFor).
  const theirs = (row: { email: string | null; name: string | null }) => (lower(row.email) ? emails.has(lower(row.email)) : names.has(personKey(row.name)));
  // Taken off a list it is leaving: by that address, or — an entry with none — only an entry Market made, never a
  // different person of the same name the client typed in themselves (28 Oct audit).
  const ours = (row: { email: string | null; name: string | null; notes: string | null }) => (lower(row.email) ? emails.has(lower(row.email)) : row.notes === FROM_MARKET && names.has(personKey(row.name)));
  const dncAgents = dnc.filter((d) => d.kind === "agent");
  const matchOf = <R extends { name: string | null; email: string | null }>(rows: R[], ag: AgentRow): R | undefined =>
    rows.find((row) => (lower(row.email) ? preferredOf(ag).includes(lower(row.email)) : personKey(row.name) === personKey(ag.full_name) && personKey(ag.full_name).length >= 5));
  const onto = a.to === "My Agents" || a.to === "DNC List";
  const adding = agents.filter((ag) => (a.to === "My Agents" ? !matchOf(mine.filter(theirs), ag) : a.to === "DNC List" ? !matchOf(dncAgents.filter(theirs), ag) : false));
  const n = agents.length;
  const who1 = n === 1 ? (agents[0].full_name ?? "1 agent") : `${n.toLocaleString("en-US")} agents`;

  // Onto the list it goes to FIRST — so a failure leaves the agent where it was, never on no list (28 Oct audit).
  // By name (and, on the DNC List, brokerage) only: never the agent database's email, nor its phone — no list a client
  // can export carries what Market itself never shows (the no-scraping rule, 28 Oct audit).
  const added: Array<{ id: string; emails: string[]; agent: AgentRow | undefined }> = [];
  if (adding.length && onto) {
    const { data, error } = a.to === "My Agents"
      ? await db.from("client_agents").insert(adding.map((ag) => ({
          client_id: C, name: ag.full_name ?? "Unnamed agent", email: null, phone: null, license: null, notes: FROM_MARKET,
          pushed_to_instantly: false, pushed_to_emailbison: false, push_error: null,
        }))).select("id, name")
      : await db.from("client_dnc_entries").insert(adding.map((ag) => ({
          client_id: C, kind: "agent", name: ag.full_name ?? "Unnamed agent", email: null, phone: null, brokerage: ag.brand ?? ag.office_name,
          domain: null, notes: FROM_MARKET, added_by: "client", pushed_to_instantly: false, pushed_to_emailbison: false, push_error: null,
        }))).select("id, name");
    if (error) return { ok: false, status: 400, error: TRY_AGAIN };
    // Each new row to its agent by name — never by the order rows come back (agents of one name share it either way).
    const byName = new Map<string, AgentRow[]>();
    for (const ag of adding) byName.set(ag.full_name ?? "Unnamed agent", [...(byName.get(ag.full_name ?? "Unnamed agent") ?? []), ag]);
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
      const agent = byName.get(row.name)?.shift();
      added.push({ id: row.id, emails: agent ? preferredOf(agent) : [], agent });
    }
  }

  // What the list means, set off as soon as the agents are on it — so a later step failing never loses it (28 Oct
  // audit): for EVERY agent moved onto it (those already there by name too), its preferred email blocked; on the DNC
  // List also stopped, with one Slack post naming those added (as an imported DNC file). The address goes only to the
  // providers' blocklists, never to Slack or a list. The preferred address only (the user's choice, 28 Oct): the
  // enriched one is a guess and may be someone else's — a block is permanent and binds every client's campaigns.
  if (onto) {
    const table = a.to === "My Agents" ? "client_agents" : "client_dnc_entries";
    const rest = agents.flatMap(preferredOf).filter((e) => !added.some((r) => r.emails.includes(e)));
    if (a.to === "DNC List" && adding.length) after(() => notifyPortalDncBulkAdd({ clientId: C, entries: adding.map((ag) => ({ name: ag.full_name, handle: null })) }));
    after(async () => {
      try {
        await blockAll(table, added, rest);
        if (a.to === "DNC List") await stopEntries(agents.flatMap((ag) => preferredOf(ag).map((email) => ({ email, name: ag.full_name }))));
      } catch (err) {
        console.error("[crm-preview] market move", err instanceof Error ? err.message : err);
      }
    });
  }
  // Counted as Market use (it is agent-database data reaching the client's lists): heavy use reaches our team's bell, as a read does — never refused.
  after(() => recordUse(createAdminSupabase(), { who, role, portalId: C, kind: "market", rows: n, now: new Date() }));
  // And our team hears of every move onto a list (the user, 28 Oct): those blocks are permanent and bind every client's campaigns.
  if (a.to === "My Agents" || a.to === "DNC List") {
    const to = a.to;
    after(() => alertMarketMove(createAdminSupabase(), { who, portalId: C, to, agents: n, now: new Date() }));
  }
  // A step after the add that did not finish: said plainly — the agents ARE on the list, blocked; trying again finishes it.
  const unfinished: DemoResult = { ok: false, status: 409, error: `${who1} ${n === 1 ? "is" : "are"} on ${a.to} now, but the rest didn't finish — please try again.` };

  // On the DNC List: each agent's preferred address kept where the reply agent and the relay look (migration 0044,
  // os_market_dnc_emails) — never on the list itself. Against the entry just added, or the one already there by name
  // (or by that address — then nothing more is needed: the entry holds it).
  if (a.to === "DNC List") {
    const keep: Array<{ entry_id: string; client_id: string; email: string; added_by: string }> = [];
    for (const ag of agents) {
      const email = preferredOf(ag)[0];
      if (!email) continue;
      const fresh = added.find((r) => r.agent === ag);
      const there = fresh ? null : matchOf(dncAgents.filter(theirs), ag);
      if (fresh) keep.push({ entry_id: fresh.id, client_id: C, email, added_by: who });
      else if (there && lower(there.email) !== email) keep.push({ entry_id: there.id, client_id: C, email, added_by: who });
    }
    if (await keepHidden(keep)) return unfinished;
  }

  // Then off the lists it is leaving — the current portal's own bulk removal (nothing outside; a block is never undone).
  const offMine = a.to !== "My Agents" ? mine.filter(ours) : [];
  const offDnc = a.to !== "DNC List" ? dncAgents.filter(ours) : [];
  if (offMine.length) {
    const r = await inParts(offMine.map((x) => x.id), (part) => call(agentsBulkRoute.POST, "POST", { token }, { ids: part }));
    if (!r.ok) return onto ? unfinished : r;
  }
  if (offDnc.length) {
    const r = await inParts(offDnc.map((x) => x.id), (part) => call(dncBulkRoute.POST, "POST", { token }, { ids: part }));
    if (!r.ok) return onto ? unfinished : r;
  }

  console.info(JSON.stringify({ tag: "[crm-preview] market move", who, client: C, to: a.to, agents: agents.length, added: adding.length, offMine: offMine.length, offDnc: offDnc.length }));
  return { ok: true, message: a.to === "Not on a list" ? `${who1} taken off every list.` : `${who1} moved to ${a.to}.` };
}
