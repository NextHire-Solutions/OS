/*
 * An agent of the agent database as an EmailBison lead — EXACTLY as the Database app's enrichment worker makes it
 * (Corofy/Database scripts/enrich-worker.mjs mapAgentToBisonLead, byPriority, statByPriority), because the team's
 * campaign emails read these fields ({FIRST_NAME}, {PHONE NUMBER}, {TOP PRODUCING CITY}…): a lead made here and one
 * made there must be the same lead. Proven against leads the worker made (2 Nov: scratchpad parity check); change
 * nothing here without changing the worker the same way.
 *
 * The email is the database's own (2 Nov, the user: "Database email, no check") — no paid check: an email that
 * passed a check when there is one (enrichment's "ok" — MillionVerifier's safe verdict — or the older "verified"),
 * else the agent's email by source priority. An agent whose checks found no usable email ("not_found") is never given
 * one.
 */

/** Per-source order, as the worker's PRIORITY_ORDERS (the team's sends default to "courted"). */
export const PRIORITY_ORDERS = {
  courted: ["agent_provided", "courted", "zillow", "realtor"],
  zillow: ["agent_provided", "zillow", "courted", "realtor"],
  realtor: ["agent_provided", "realtor", "courted", "zillow"],
} as const;
export type PriorityOrder = readonly string[];

/** An agent as the worker loads it: the row, its first MLS code, per-source values (cities normalised) and stats. */
export interface LeadAgent {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  buy_side_dollar?: number | string | null;
  list_side_dollar?: number | string | null;
  office_city?: string | null;
  office_state?: string | null;
  preferred_phone?: string | null;
  preferred_email?: string | null;
  sales_volume?: number | string | null;
  approx_gci?: number | string | null;
  closed_rentals?: number | string | null;
  most_transacted_city?: string | null;
  transacted_state?: string | null;
  avg_sale_price?: number | string | null;
  closed_transactions?: number | string | null;
  units?: number | string | null;
  office_name?: string | null;
  brand?: string | null;
  mls_code?: string | null;
  sources?: string[] | null;
  source_ids?: Record<string, Record<string, unknown> | null> | null;
  stats_by_source?: Record<string, Record<string, unknown> | null> | null;
  enriched_email?: string | null;
  enriched_email_status?: string | null;
}

export interface BisonLeadPayload {
  first_name: string;
  last_name: string;
  email: string;
  company?: string;
  custom_variables: Array<{ name: string; value: string }>;
}

type Agent = LeadAgent & Record<string, unknown>;

function srcVal(agent: Agent, src: string, key: string, canonicalKey: string): unknown {
  const v = agent.source_ids?.[src]?.[key];
  if (v != null && v !== "") return v;
  if (src === "courted" && (agent.sources ?? []).includes("courted")) return agent[canonicalKey] ?? null;
  return null;
}

export function byPriority(agent: Agent, order: PriorityOrder, key: string, canonicalKey: string): unknown {
  for (const src of order) {
    const v = srcVal(agent, src, key, canonicalKey);
    if (v != null && v !== "") return v;
  }
  return agent[canonicalKey] ?? null; // merged column as the last resort
}

export function statByPriority(agent: Agent, order: PriorityOrder, key: string, canonicalKey: string): unknown {
  for (const src of order) {
    const v = agent.stats_by_source?.[src]?.[key];
    if (v != null) return v;
  }
  return agent[canonicalKey] ?? null;
}

const money = (v: unknown) => (v == null || v === "" ? "" : `$${Math.round(Number(v)).toLocaleString("en-US")}`);
const num = (v: unknown) => (v == null ? "0" : String(v));
const cityState = (city: unknown, st: unknown) => (city ? (st ? `${city}, ${st}` : String(city)) : "");
function splitName(full: string | null | undefined): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/);
  return { first: parts[0] || "Unknown", last: parts.slice(1).join(" ") || "-" };
}

/** The worker's lead: names, email, company and the 13 custom variables (the Courted profile always blank). */
export function mapAgentToBisonLead(agent: LeadAgent, email: string, mlsCode: string | null | undefined, order: PriorityOrder = PRIORITY_ORDERS.courted): BisonLeadPayload {
  const a = agent as Agent;
  const first = a.first_name || splitName(a.full_name).first;
  const last = a.last_name || splitName(a.full_name).last;
  const vars: Array<[string, string]> = [
    ["buy-side", money(a.buy_side_dollar)],
    ["list-side", money(a.list_side_dollar)],
    ["office city", cityState(a.office_city, a.office_state)],
    ["phone number", String(byPriority(a, order, "phone", "preferred_phone") ?? "")],
    ["sales volume", money(a.sales_volume)],
    ["estimated gci", money(a.approx_gci)],
    ["closed rentals", num(a.closed_rentals)],
    ["courted profile", ""], // never the Courted link (the client's request, Aug 2026)
    ["mls affiliation", mlsCode ?? ""],
    ["top producing city", cityState(byPriority(a, order, "city", "most_transacted_city"), a.transacted_state)],
    ["average sales price", money(a.avg_sale_price)],
    ["closed transactions", num(statByPriority(a, order, "closed_transactions", "closed_transactions"))],
    ["units", num(statByPriority(a, order, "units", "units"))],
  ];
  const company = (byPriority(a, order, "office_name", "office_name") as string | null) || a.brand || undefined;
  return {
    first_name: first,
    last_name: last,
    email,
    ...(company ? { company } : {}),
    custom_variables: vars.map(([name, value]) => ({ name, value })),
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The address this agent is given, from the database alone — or why none: a verified enrichment result first, else
 * the agent's email by source priority; never one a check already failed ("not_found").
 */
/** The enrichment verdicts that mean "this address passed a check" (2 Nov: 107,640 agents "ok", 27,222 "verified"). */
const PASSED = new Set(["ok", "verified"]);

export function databaseEmail(agent: LeadAgent, order: PriorityOrder = PRIORITY_ORDERS.courted): { email: string } | { skip: string } {
  const verified = PASSED.has(agent.enriched_email_status ?? "") ? (agent.enriched_email ?? "").trim().toLowerCase() : "";
  if (verified && EMAIL.test(verified)) return { email: verified };
  if (agent.enriched_email_status === "not_found") return { skip: "its email already failed a check" };
  const raw = byPriority(agent as Agent, order, "email", "preferred_email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return EMAIL.test(email) ? { email } : { skip: "no email in the agent database" };
}
