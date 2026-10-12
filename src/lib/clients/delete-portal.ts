import "server-only";

import { osTable } from "./os-db";
import { countCascade, type CascadeCounts } from "./delete";
import { needsAcknowledgement, portalHasContent } from "./delete-rule";
import {
  blockReason,
  confirmationMatches,
  exceptionReason,
  leavesClientWithoutPortal,
  nextLink,
  ownerOf,
  portalIsLive,
  type OwnerRow,
  type PortalFacts,
} from "./delete-portal-rule";
import { getMasterInboxSupabase } from "@/lib/tools/master-inbox/supabase";

/*
 * Deleting one client portal, and leaving the client.
 *
 * The rules are in delete-portal-rule.ts; read its header first. This file is
 * the reading and the writing, in the order that keeps a failure harmless.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DATABASE DOES BY ITSELF
 *
 * Deleting the Master Inbox `clients` row cascades, by foreign key:
 *
 *   client_pipeline_entries   CASCADE    the portal's pipeline (and its notes)
 *   client_agents             CASCADE    their agent roster
 *   client_dnc_entries        CASCADE    their do-not-contact list
 *   client_team_members       CASCADE    their team
 *   client_pipeline_stages    CASCADE    their custom stages
 *   lists                     CASCADE    the client's list in the inbox's Clients panel
 *   os_campaign_portals       CASCADE    "this campaign's leads go to this portal"
 *   threads, external_intros  SET NULL   kept, untagged
 *
 * The campaign routing rows matter most: reply ingestion reads them first
 * (derive.ts, in both apps), and a row pointing at a deleted portal would hand
 * it an id that no longer exists. They go with the portal, so routing falls
 * back to the client's other portal or to the name match, as before the
 * choice was made.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT, AND SO THIS DOES
 *
 *   the Intro Macro template   no foreign key; matched on the exact name
 *                              onboarding writes, as delete.ts does
 *   os_clients.mi_client_id    a plain column, no foreign key. If it pointed
 *                              at this portal it moves to the client's other
 *                              portal, or is cleared
 *   the reason, for Consistency  written when the client is left with no
 *                              portal, so that reads as a decision somebody
 *                              made rather than a fault to chase
 *
 * Counts are read FIRST and shown, exactly as Clients → Delete does: "removes
 * its portal" says nothing about whether that portal is an empty shell or
 * holds 400 agents.
 */

export interface PortalDeletePlan {
  id: string;
  name: string;
  /** Present when this must not proceed; nothing else in the plan matters then. */
  blocked: string | null;
  live: boolean;
  /** What the cascade would take. */
  cascade: CascadeCounts;
  /** The client's list(s) in the inbox's Clients panel. */
  lists: number;
  /** Campaigns whose leads were routed to this portal. */
  campaignChoices: number;
  /** Its "Intro Macro - <name>" reply template exists. */
  hasTemplate: boolean;
  /** True when the portal holds anything the delete destroys. */
  hasContent: boolean;
  /** The client it belongs to, or null for a portal no client is tied to. */
  owner: { id: string; name: string; status: string } | null;
  /** The owner's other portals, which stay. */
  otherPortals: { id: string; name: string }[];
  /** True when the owner would be left with no portal at all. */
  leavesClientWithoutPortal: boolean;
  willDelete: string[];
  willKeep: string[];
  warnings: string[];
}

export interface PortalDeleteResult {
  name: string;
  removed: string[];
  failed: { what: string; error: string }[];
}

interface ClientRow extends OwnerRow {
  status: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function loadPortal(id: string): Promise<PortalFacts | null> {
  const { data, error } = await getMasterInboxSupabase()
    .from("clients")
    .select("id, name, slug, portal_token, portal_enabled")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the portal: ${error.message}`);
  if (!data) return null;
  const r = data as { id: string; name: string | null; slug: string | null; portal_token: string | null; portal_enabled: boolean | null };
  return { id: r.id, name: r.name ?? "", slug: r.slug, portalToken: r.portal_token, portalEnabled: r.portal_enabled };
}

/*
 * Read fresh, never through the 15-second master cache: this decides whose
 * record a destructive act touches, and a client added a moment ago must not
 * be missing from it.
 */
async function loadClients(): Promise<ClientRow[]> {
  const { data, error } = await osTable("os_clients").select("id, name, aliases, status, mi_client_id");
  if (error) throw new Error(`Could not read the client list: ${error.message}`);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    aliases: Array.isArray(r.aliases) ? (r.aliases as unknown[]).map(String) : [],
    status: String(r.status ?? ""),
    miClientId: typeof r.mi_client_id === "string" && r.mi_client_id ? r.mi_client_id : null,
  }));
}

async function count(table: "lists" | "reply_templates", column: string, value: string): Promise<number> {
  const { count: n } = await getMasterInboxSupabase()
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq(column, value);
  return n ?? 0;
}

async function countCampaignChoices(miClientId: string): Promise<number> {
  try {
    const { count: n, error } = await osTable("os_campaign_portals")
      .select("campaign_id", { count: "exact", head: true })
      .eq("mi_client_id", miClientId);
    return error ? 0 : (n ?? 0);
  } catch {
    return 0; // migration 0025 not run: there are no choices to lose
  }
}

/** What deleting this portal would do. Nothing is changed. */
export async function planPortalDelete(id: string): Promise<PortalDeletePlan | null> {
  const portal = await loadPortal(id);
  if (!portal) return null;

  const db = getMasterInboxSupabase();
  const [cascade, lists, campaignChoices, templates, clients, siblings] = await Promise.all([
    countCascade(id),
    count("lists", "client_id", id),
    countCampaignChoices(id),
    count("reply_templates", "name", `Intro Macro - ${portal.name}`),
    loadClients(),
    db.from("clients").select("id, name, slug").neq("id", id),
  ]);

  const owner = ownerOf(clients, portal);
  const otherPortals = owner
    ? ((siblings.data ?? []) as { id: string; name: string | null; slug: string | null }[])
        .filter((r) => r.slug !== "unknown" && ownerOf(clients, { id: r.id, name: r.name ?? "" })?.id === owner.id)
        .map((r) => ({ id: r.id, name: r.name ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const orphaned = leavesClientWithoutPortal(owner, otherPortals.map((p) => p.id));
  const hasContent = portalHasContent(cascade);

  const willDelete: string[] = ["the portal and its link, permanently"];
  if (cascade.pipelineEntries) willDelete.push(`${plural(cascade.pipelineEntries, "lead")} in its pipeline, with their notes`);
  if (cascade.agents) willDelete.push(`${plural(cascade.agents, "agent")} on its agent roster`);
  if (cascade.dncEntries) willDelete.push(`${plural(cascade.dncEntries, "do-not-contact entry", "do-not-contact entries")}`);
  if (cascade.teamMembers) willDelete.push(`${plural(cascade.teamMembers, "team member")}`);
  if (lists) willDelete.push(`its list in the inbox's Clients panel`);
  if (campaignChoices) willDelete.push(`${plural(campaignChoices, "campaign")} routed to this portal — their new replies go by name again`);
  if (templates) willDelete.push(`its "Intro Macro - ${portal.name}" reply template`);

  const willKeep: string[] = [];
  if (owner) {
    willKeep.push(`the client "${owner.name}" — in Clients, billing, campaigns and every other tool`);
    for (const p of otherPortals) willKeep.push(`its other portal "${p.name}"`);
  }
  if (cascade.threads) willKeep.push(`${plural(cascade.threads, "conversation")} — kept, but they lose this client's tag`);

  const warnings: string[] = [
    "The portal link is random and cannot be recreated. Anyone who has it will find it no longer opens.",
  ];
  if (hasContent) warnings.push("Everything listed under “This removes” is deleted for good. There is no undo.");
  /*
   * A portal's leads ARE the client's introductions: Client Health recounts
   * every week and billing cycle from them on each sync (sync/runSync.ts,
   * runCorofy), and so does anything else fed by /clients/intros. Deleting
   * them is not only "the portal looks empty" — the client's past numbers
   * fall. Said here because nothing else on screen would.
   */
  if (cascade.pipelineEntries > 0) {
    warnings.push(
      `Those ${plural(cascade.pipelineEntries, "lead")} are this client's introductions on record. Its introduction counts — Client Health's weekly and billing-cycle numbers, and any report built on them — will drop by that many, past weeks included.`,
    );
  }
  else warnings.push("This portal is empty, so nothing inside it is lost.");
  if (orphaned && owner) {
    warnings.push(
      `"${owner.name}" will have no portal. It stays a client; Consistency will show the portal as deleted on purpose, with today's date.`,
    );
  }
  if (!owner) warnings.push("No client is tied to this portal, so no client record changes.");

  return {
    id: portal.id,
    name: portal.name,
    blocked: blockReason(portal),
    live: portalIsLive(portal),
    cascade,
    lists,
    campaignChoices,
    hasTemplate: templates > 0,
    hasContent,
    owner: owner ? { id: owner.id, name: owner.name, status: owner.status } : null,
    otherPortals,
    leavesClientWithoutPortal: orphaned,
    willDelete,
    willKeep,
    warnings,
  };
}

export class PortalDeleteRefused extends Error {
  // Assigned explicitly, not a parameter property: Node's type stripping (the
  // test runner) cannot remove those.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PortalDeleteRefused";
    this.status = status;
  }
}

/**
 * Deletes the portal.
 *
 * `confirm` must be the portal's exact name, and a portal that holds anything
 * needs `acceptDataLoss` as well — typing a name carefully is not the same as
 * knowing what is inside the thing being deleted. Everything is re-read here:
 * the plan the dialog showed is not trusted, because a portal switched back on
 * since then must still be refused.
 */
export async function deletePortal(
  id: string,
  { confirm, acceptDataLoss = false, by = null }: { confirm: string; acceptDataLoss?: boolean; by?: string | null },
): Promise<PortalDeleteResult> {
  const plan = await planPortalDelete(id);
  if (!plan) throw new PortalDeleteRefused("That portal no longer exists.", 404);
  if (plan.blocked) throw new PortalDeleteRefused(plan.blocked, 409);
  if (!confirmationMatches(confirm, plan.name)) {
    throw new PortalDeleteRefused("The confirmation text must repeat the portal's name exactly.", 400);
  }
  if (needsAcknowledgement(plan.hasContent, acceptDataLoss)) {
    throw new PortalDeleteRefused(
      "This portal is not empty. Acknowledge that what is inside it will be deleted to proceed.",
      400,
    );
  }

  const db = getMasterInboxSupabase();
  const removed: string[] = [];
  const failed: { what: string; error: string }[] = [];

  /*
   * The row. `.eq("portal_enabled", false)` would be tidier than re-reading,
   * but a portal with no token is "not live" with any flag — so the block
   * above is the test, and this delete is by id alone.
   */
  const { error } = await db.from("clients").delete().eq("id", id);
  if (error) throw new PortalDeleteRefused(`The portal could not be deleted: ${error.message}`, 500);
  removed.push("the portal and everything inside it");

  // No foreign key reaches the template; the exact name, never a pattern.
  if (plan.hasTemplate) {
    const { error: tErr } = await db.from("reply_templates").delete().eq("name", `Intro Macro - ${plan.name}`);
    if (tErr) failed.push({ what: "Its Intro Macro template", error: tErr.message });
    else removed.push("its Intro Macro template");
  }

  /*
   * The client's record. From here a failure cannot undo the delete, so each
   * step is attempted and reported on its own: a stale link or a missing
   * reason is something Consistency shows and a person can fix; a thrown error
   * that hid the fact the portal is already gone is not.
   */
  if (plan.owner) {
    const clients = await loadClients().catch(() => [] as ClientRow[]);
    const owner = clients.find((c) => c.id === plan.owner!.id) ?? null;
    const link = nextLink(owner, id, plan.otherPortals.map((p) => p.id));
    if (link.change) {
      const { error: lErr } = await osTable("os_clients").update({ mi_client_id: link.to }).eq("id", plan.owner.id);
      if (lErr) failed.push({ what: `Updating ${plan.owner.name}'s record`, error: lErr.message });
      else removed.push(link.to ? `${plan.owner.name}'s record now points at its other portal` : `${plan.owner.name}'s link to the deleted portal`);
    }
    if (plan.leavesClientWithoutPortal) {
      try {
        const { error: xErr } = await osTable("os_client_tool_exceptions").upsert(
          { os_client_id: plan.owner.id, tool: "master_inbox", reason: exceptionReason(plan.name, new Date(), by), created_by: by },
          { onConflict: "os_client_id,tool" },
        );
        if (xErr) failed.push({ what: "Noting the reason for Consistency", error: xErr.message });
      } catch (e) {
        failed.push({ what: "Noting the reason for Consistency", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return { name: plan.name, removed, failed };
}
