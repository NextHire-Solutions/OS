import "server-only";

import { z } from "zod";

import { readOnly } from "@/lib/tools/assistant/read-only";
import { getCorofySupabase } from "@/lib/tools/corofy/supabase";

import type { Db, Res } from "./demo";
import type { ListName, MarketQuery } from "./market-model";

/*
 * Market's "Move to" on the Demo Portal (23 Oct — the client: Market's buttons
 * said "drawn only"). Ticked agents, or one agent from its List menu, go to
 * Prospects, My Agents or the DNC List, or come off every list — on the Demo
 * Portal only, with none of a live portal's side effects (nothing reaches a
 * campaign, Slack, a text or Follow Up Boss).
 *
 * An agent is on one list: the page shows the first of DNC, My Agents, its
 * pipeline, Prospects (market-model listFor). So a move takes the agent off
 * the lists it is leaving — by its addresses, or by its name where a list
 * entry has no address, as listFor matches — and onto the one it goes to.
 *
 * NO EMAIL FROM THE AGENT DATABASE IS COPIED onto a list (the user, 17 Oct: no
 * one may extract the agent data). My Agents and the DNC List show their
 * entries' emails and export them; an agent moved there from Market is saved
 * by name, brokerage and phone, and the page still places it by name. The
 * Demo's Prospects keep only the agent's id (migration 0041); a real client's
 * prospects are its campaign leads in the agent database.
 *
 * This file only READS (the agent database, the Demo's prospects) and checks
 * the request; the moves themselves are in demo.ts, the preview's one writer.
 */

export const MOVE_TARGETS = ["Prospects", "My Agents", "DNC List", "Not on a list"] as const satisfies readonly ListName[];
export type MoveTarget = (typeof MOVE_TARGETS)[number];
/** At most this many agents in one move — "Select all that match" past it asks for narrower filters. */
export const MAX_MOVE = 1000;

const agentId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
export const marketAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("market.move"), ids: z.array(agentId).min(1).max(MAX_MOVE), to: z.enum(MOVE_TARGETS), onlyUnlisted: z.boolean().optional() }),
  // Every agent matching the page's filters (the query string the page sends for its list).
  z.object({ type: z.literal("market.moveAll"), list: z.enum(["market", "prospects"]), query: z.string().max(4000), to: z.enum(MOVE_TARGETS), onlyUnlisted: z.boolean().optional() }),
]);
export type MarketAction = z.infer<typeof marketAction>;

const agentDb = () => readOnly(getCorofySupabase());

/** The fields the Demo's Prospects page and a move need, from the agent database. Emails stay on the server. */
export interface AgentRow {
  id: string;
  full_name: string | null;
  preferred_email: string | null;
  enriched_email: string | null;
  preferred_phone: string | null;
  brand: string | null;
  office_name: string | null;
  title: string | null;
  office_city: string | null;
  office_county: string | null;
  home_city: string | null;
  home_county: string | null;
  most_transacted_city: string | null;
  most_transacted_county: string | null;
  sales_volume: number | null;
  units: number | null;
  est_time_in_industry_months: number | null;
}
const AGENT_COLS = "id, full_name, preferred_email, enriched_email, preferred_phone, brand, office_name, title, office_city, office_county, home_city, home_county, most_transacted_city, most_transacted_county, sales_volume, units, est_time_in_industry_months";

/** Agents by id, in chunks the gateway's URL limit allows. */
export async function agentsByIds(ids: readonly string[]): Promise<AgentRow[]> {
  const out: AgentRow[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await agentDb().from("agents").select(AGENT_COLS).in("id", ids.slice(i, i + 150));
    if (error) throw new Error(`agents: ${error.message}`);
    out.push(...((data ?? []) as unknown as AgentRow[]));
  }
  return out;
}

export const missingTable = (r: Res) => !!r.error && /os_demo_prospects|does not exist|schema cache|PGRST205/i.test(r.error.message);
export const PROSPECTS_MIGRATION = "The Demo Portal's Prospects need migration 0041_demo_prospects.sql run first.";

/** The Demo Portal's prospects (agent ids), or null before migration 0041. */
export async function demoProspectIds(db: Db, portalId: string): Promise<string[] | null> {
  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const r: Res = await db.from("os_demo_prospects").select("agent_id").eq("portal_id", portalId).order("added_at", { ascending: false }).range(from, from + 999);
    if (missingTable(r)) return null;
    if (r.error) throw new Error(`os_demo_prospects: ${r.error.message}`);
    const rows = (r.data ?? []) as Array<{ agent_id: string }>;
    out.push(...rows.map((x) => x.agent_id));
    if (rows.length < 1000) return out;
  }
}

export const lower = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
export const emailsOf = (a: AgentRow) => [a.preferred_email, a.enriched_email].map(lower).filter(Boolean);

/* ------------------------------------------------- the Demo's Prospects page --- */

const inRange = (v: number | null, r: { min: number | null; max: number | null }) => (r.min === null || (v !== null && v >= r.min)) && (r.max === null || (v !== null && v <= r.max));
const years = (a: AgentRow) => (a.est_time_in_industry_months === null ? null : Math.floor(a.est_time_in_industry_months / 12));

/* A title's parts, as the agent database compares them (fn_title_tokens): "Salesperson, Team Leader" is both. */
const titleTokens = (t: string | null) => (t ?? "").split(",").map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);

/**
 * The Demo's prospects that match the page's filters, as Market's search
 * applies them: sales volume, units and years as ranges; any of the
 * brokerages, offices, cities or counties (office, home or most transacted)
 * and titles — and none of the left-out ones, where an agent with nothing on
 * record stays (fn_agent_where's rule). A name search narrows nothing —
 * matching agents come first, as in the Database app.
 */
export function filterProspects(rows: AgentRow[], q: MarketQuery): AgentRow[] {
  const set = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const tokens = (xs: string[]) => new Set(xs.flatMap((t) => titleTokens(t)));
  const [brands, offices, cities, counties, titles] = [set(q.brokerages), set(q.offices), set(q.cities), set(q.counties), tokens(q.titles)];
  const [noBrands, noOffices, noCities, noCounties, noTitles] = [set(q.not.brokerages), set(q.not.offices), set(q.not.cities), set(q.not.counties), tokens(q.not.titles)];
  const inPlace = (a: AgentRow, cs: Set<string>, ks: Set<string>) =>
    [a.office_city, a.home_city, a.most_transacted_city].some((c) => cs.has(lower(c))) || [a.office_county, a.home_county, a.most_transacted_county].some((c) => ks.has(lower(c)));
  return rows.filter((a) =>
    inRange(a.sales_volume, q.volume) && inRange(a.units, q.units) && inRange(years(a), q.years)
    && (!brands.size || brands.has(lower(a.brand))) && (!offices.size || offices.has(lower(a.office_name)))
    && (!(cities.size || counties.size) || inPlace(a, cities, counties))
    && (!titles.size || titleTokens(a.title).some((t) => titles.has(t)))
    && !noBrands.has(lower(a.brand)) && !noOffices.has(lower(a.office_name))
    && !inPlace(a, noCities, noCounties)
    && !titleTokens(a.title).some((t) => noTitles.has(t)));
}

const SORT_FIELD: Record<MarketQuery["sort"], (a: AgentRow) => string | number | null> = {
  name: (a) => a.full_name, brokerage: (a) => a.brand, officeCity: (a) => a.office_city, transactedCity: (a) => a.most_transacted_city,
  title: (a) => a.title, volume: (a) => a.sales_volume, units: (a) => a.units,
};

export function sortProspects(rows: AgentRow[], q: MarketQuery): AgentRow[] {
  const get = SORT_FIELD[q.sort];
  const dir = q.dir === "asc" ? 1 : -1;
  const needle = q.q.trim().toLowerCase();
  const hit = (a: AgentRow) => (needle && lower(a.full_name).includes(needle) ? 0 : 1);
  return [...rows].sort((a, b) => {
    const h = hit(a) - hit(b);
    if (h) return h;
    const x = get(a), y = get(b);
    // Blanks last, either way.
    if (x === null || x === "") return y === null || y === "" ? 0 : 1;
    if (y === null || y === "") return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}
