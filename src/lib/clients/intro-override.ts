import "server-only";

import { osTable } from "@/lib/clients/os-db";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { syncIntroTemplate, type IntroTemplateOutcome } from "@/lib/clients/intro-template-sync";
import {
  customIntro,
  introReady,
  moreContactsFrom,
  missingIntroFields,
  renderIntroMacroTemplate,
  routeIntro,
  slotTerritories,
  type IntroMacroClient,
} from "@/lib/tools/master-inbox/inbox/intro-macro";

/*
 * A client's own introduction (os_clients.intro_override, OS migration 0026).
 *
 * When set it is what the Introduce button, the reply agent's handover and
 * the stored "Intro Macro - <client>" template send, in place of the
 * standard wording. Blank means the standard wording.
 *
 * Every read tolerates the column not existing yet: before 0026 runs a
 * client simply has no custom intro.
 */

export class IntroOverrideError extends Error {}

/** Longer than any introduction anyone would paste; stops a runaway paste. */
export const INTRO_OVERRIDE_MAX = 5000;

const missingColumn = (msg: string) => /intro_override/.test(msg);

/** The client's custom intro, or null (none set, or 0026 not run). */
export async function readIntroOverride(clientId: string): Promise<string | null> {
  const { data, error } = await osTable("os_clients").select("intro_override").eq("id", clientId).maybeSingle();
  if (error) {
    if (missingColumn(error.message)) return null;
    throw new Error(error.message);
  }
  return ((data as { intro_override?: string | null } | null)?.intro_override ?? "").trim() || null;
}

const CLIENT_COLS =
  "id, name, contact_name, contact_role, contact_email, " +
  "contact2_name, contact2_role, contact2_email, " +
  "contact3_name, contact3_role, contact3_email, brokerage";

/** People 4+ (0028); none before the migration. */
async function readMore(clientId: string) {
  const { data, error } = await osTable("os_clients").select("more_contacts").eq("id", clientId).maybeSingle();
  return error ? [] : moreContactsFrom((data as { more_contacts?: unknown } | null)?.more_contacts);
}

/** People 1-3's territories (0029); {} before the migration. */
async function readTerritories(clientId: string): Promise<unknown> {
  const { data, error } = await osTable("os_clients").select("contact_territories").eq("id", clientId).maybeSingle();
  return error ? {} : (data as { contact_territories?: unknown } | null)?.contact_territories ?? {};
}

async function macroClient(clientId: string): Promise<IntroMacroClient> {
  const { data, error } = await osTable("os_clients").select(CLIENT_COLS).eq("id", clientId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new IntroOverrideError("No such client.");
  const row = data as unknown as Record<string, string | null>;
  const territories = await readTerritories(clientId);
  return {
    name: row.name ?? "",
    contactName: row.contact_name,
    contactRole: row.contact_role,
    contactEmail: row.contact_email,
    contactTerritories: slotTerritories(territories, 1),
    extraContacts: [
      ...([2, 3] as const).map((n) => ({
        name: row[`contact${n}_name`],
        role: row[`contact${n}_role`],
        email: row[`contact${n}_email`],
        territories: slotTerritories(territories, n),
      })),
      ...(await readMore(clientId)),
    ],
    brokerage: row.brokerage,
    introOverride: await readIntroOverride(clientId),
  };
}

export interface IntroView {
  /** The standard wording from the contacts, or null when they are incomplete. */
  standard: string | null;
  /** What is missing for the standard wording ("contact name and role"). */
  missing: string[];
  /** The client's own introduction, when set. */
  custom: string | null;
  /** Whether there is an introduction to send at all. */
  ready: boolean;
  /** False until migration 0026 has run: a custom intro cannot be saved yet. */
  canSaveCustom: boolean;
  /**
   * When the client's people have territories (0029): each of the client's
   * campaigns, newest reply first, with who its leads are introduced to.
   * Null when nobody has a territory — everyone is on every introduction.
   */
  routes: IntroRouteRow[] | null;
}

export interface IntroRouteRow {
  campaign: string;
  /** The places in the campaign name that picked the people. */
  matched: string[];
  /** Who its leads are introduced to. */
  people: string[];
  /** The campaign names no territory: everyone is introduced. */
  fallback: boolean;
  /** Conversations from this campaign, and the newest one's date. */
  conversations: number;
  lastAt: string | null;
}

/**
 * The client's campaigns, from its conversations in Master Inbox (any of its
 * portals), newest first. Best effort: [] when they cannot be read.
 */
async function clientCampaigns(clientId: string): Promise<Array<{ campaign: string; conversations: number; lastAt: string | null }>> {
  try {
    const { data: rec } = await osTable("os_clients").select("mi_client_id").eq("id", clientId).maybeSingle();
    const portals = new Set<string>();
    const linked = (rec as { mi_client_id?: string | null } | null)?.mi_client_id;
    if (linked) portals.add(linked);
    const { data: routed } = await osTable("os_campaign_portals").select("mi_client_id").eq("os_client_id", clientId);
    for (const r of (routed ?? []) as Array<{ mi_client_id?: string }>) if (r.mi_client_id) portals.add(r.mi_client_id);
    if (!portals.size) return [];
    const { data } = await createAdminSupabase()
      .from("threads")
      .select("campaign_name, last_message_at")
      .in("client_id", [...portals])
      .not("campaign_name", "is", null)
      .order("last_message_at", { ascending: false })
      .limit(5000);
    const by = new Map<string, { campaign: string; conversations: number; lastAt: string | null }>();
    for (const t of (data ?? []) as Array<{ campaign_name: string; last_message_at: string | null }>) {
      const name = t.campaign_name.trim();
      if (!name) continue;
      const cur = by.get(name) ?? { campaign: name, conversations: 0, lastAt: t.last_message_at };
      cur.conversations++;
      by.set(name, cur);
    }
    return [...by.values()];
  } catch {
    return [];
  }
}

export async function introView(clientId: string): Promise<IntroView> {
  const client = await macroClient(clientId);
  const missing = missingIntroFields(client);
  const probe = await osTable("os_clients").select("intro_override").limit(1);
  let routes: IntroRouteRow[] | null = null;
  if (routeIntro(client, null).route.byTerritory) {
    routes = (await clientCampaigns(clientId)).slice(0, 40).map((c) => {
      const { route } = routeIntro(client, c.campaign);
      return { ...c, matched: route.matched, people: route.people, fallback: route.fallback };
    });
  }
  return {
    standard: missing.length ? null : renderIntroMacroTemplate(client),
    missing,
    custom: customIntro(client),
    ready: introReady(client),
    canSaveCustom: !probe.error,
    routes,
  };
}

/**
 * Save (or clear, with null / blank) the client's custom intro, then bring
 * the stored "Intro Macro" template in step. The column write is what
 * matters; a template sync failure is reported, not thrown.
 */
export async function saveIntroOverride(
  clientId: string,
  text: string | null,
): Promise<{ view: IntroView; template: IntroTemplateOutcome | "failed" }> {
  const value = (text ?? "").replace(/\r\n/g, "\n").trim() || null;
  if (value && value.length > INTRO_OVERRIDE_MAX) {
    throw new IntroOverrideError(`The introduction is too long (${value.length} characters; the limit is ${INTRO_OVERRIDE_MAX}).`);
  }
  const { error } = await osTable("os_clients")
    .update({ intro_override: value, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) {
    if (missingColumn(error.message)) {
      throw new IntroOverrideError("Custom introductions need database migration 0026 first.");
    }
    throw new Error(error.message);
  }
  let template: IntroTemplateOutcome | "failed";
  try {
    template = await syncIntroTemplate(await macroClient(clientId));
  } catch (e) {
    console.error("[intro-override] template sync", e);
    template = "failed";
  }
  return { view: await introView(clientId), template };
}
