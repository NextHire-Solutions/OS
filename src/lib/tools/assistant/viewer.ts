/*
 * Who the assistant is answering, and so which of its tools it may use (18 Nov, the user: "give access to the AI
 * assistant on the OS to Gabriel Castillo" — and, asked, "Only what he can see").
 *
 * Admins: every tool, as before. Anyone else the Assistant page is opened to by name (identity/named-pages.ts): only
 * the tools whose data that person can open in the OS — each tool needs the switch (Team access) of the screen that
 * shows the same data. Money is the Billing tab's people only (clients/billing-access.ts); commissions, Team access,
 * notifications, Consistency and the Reply agent stay with admins. A tool with no rule here is admins only: a new
 * tool is never opened to a teammate by accident.
 *
 * Two tools read several products at once and are scoped rather than refused (engine.ts): client_overview without
 * Agent Search leaves its scrape figures out; client_report leaves out Stripe billing (unless a Billing-tab person)
 * and scrapes (unless Agent Search). Pure: no I/O.
 */

import type { ToolId } from "@/lib/bs-auth";

export interface AssistantViewer {
  email: string;
  admin: boolean;
  /** The person's switches on Team access (their session's grants). */
  grants: readonly string[];
  /** One of the Billing tab's people (clients/billing-access.ts canSeeBillingTab). */
  billing: boolean;
}

type Need =
  /** Anyone who may use the assistant. */
  | { kind: "everyone" }
  /** Admins only. */
  | { kind: "admin" }
  /** The Billing tab's people (and admins). */
  | { kind: "billing" }
  /** Any one of these switches. */
  | { kind: "any"; of: readonly ToolId[] }
  /** All of these switches (a tool that reads several products). */
  | { kind: "all"; of: readonly ToolId[] };

const everyone: Need = { kind: "everyone" };
const admin: Need = { kind: "admin" };
const billing: Need = { kind: "billing" };
const any = (...of: ToolId[]): Need => ({ kind: "any", of });
const all = (...of: ToolId[]): Need => ({ kind: "all", of });

/** Each tool, and the switch whose screen shows the same data. */
export const TOOL_NEEDS: Readonly<Record<string, Need>> = {
  // Names and Home: a client's name, and Home's own figures, which everyone sees.
  find_client: everyone,
  workspace_home: everyone,
  // The master client record — the Clients page.
  client_record: any("roster"),
  list_clients: any("roster"),
  profile_completeness: any("roster"),
  client_introduction: any("roster", "inbox"),
  // Several products at once; Agent Search's figures and Stripe billing are left out unless held (engine.ts).
  client_overview: all("inbox", "analytics", "clients", "portals"),
  client_report: all("roster", "inbox", "portals", "analytics", "clients"),
  // Client Health.
  client_rankings: any("clients"),
  client_commercials: any("clients"),
  billing_cycles: any("clients"),
  client_success: any("clients"),
  sending_volume: any("clients"),
  client_reply_rates: any("clients", "analytics"),
  // Campaign Analytics and Campaign Management.
  campaigns_for_client: any("analytics", "campaigns"),
  campaign_kpis: any("analytics"),
  attribution: any("analytics"),
  campaign_detail: any("analytics", "campaigns"),
  campaign_copy: any("analytics", "campaigns"),
  send_schedule: any("campaigns", "analytics"),
  // Inboxes and Infrastructure.
  inbox_deliverability: any("inboxes", "analytics"),
  infrastructure_health: any("inboxes", "analytics"),
  // Master Inbox.
  inbox_activity: any("inbox"),
  outcomes: any("inbox"),
  reminders: any("inbox"),
  recent_replies: any("inbox"),
  find_lead: any("inbox"),
  search_conversations: any("inbox"),
  reply_templates: any("inbox"),
  recent_introductions: any("inbox", "portals"),
  // Master Inbox labels (27 Nov).
  positive_replies: any("inbox"),
  // Client Portals.
  client_portals: any("portals"),
  portal_pipeline: any("portals"),
  // Agent Search and the agent database.
  scrape_activity: any("search"),
  mls_coverage: any("search"),
  agent_database: any("search"),
  find_agent: any("search"),
  search_agents: any("search"),
  agent_places: any("search"),
  // Onboarding.
  onboarding_records: any("onboarding"),
  // Performance (its own switch).
  business_performance: any("performance"),
  // Money: the Billing tab's people.
  client_billing: billing,
  billing_overview: billing,
  // Admins only: everyone's payouts, Team access, the bell, Consistency, the Reply agent.
  commissions: admin,
  team: admin,
  notifications: admin,
  // Tickets (20 Nov): its own switch.
  tickets: any("tickets"),
  ticket_thread: any("tickets"),
  data_consistency: admin,
  reply_agent_status: admin,
  // Agents added to campaigns through Claude (28 Nov): the action is admins only, so its progress is too.
  campaign_agent_jobs: admin,
};

/** Whether this person may use this tool. An unknown tool, or one with no rule, is admins only. */
export function toolAllowed(name: string, v: AssistantViewer): boolean {
  if (v.admin) return true;
  const need = Object.prototype.hasOwnProperty.call(TOOL_NEEDS, name) ? TOOL_NEEDS[name] : admin;
  switch (need.kind) {
    case "everyone": return true;
    case "admin": return false;
    case "billing": return v.billing;
    case "any": return need.of.some((g) => v.grants.includes(g));
    case "all": return need.of.every((g) => v.grants.includes(g));
  }
}

/** The tools of `names` this person may use, in the same order. */
export function allowedToolNames(names: readonly string[], v: AssistantViewer): string[] {
  return names.filter((n) => toolAllowed(n, v));
}

/** Holds Agent Search — client_overview / client_report keep their scrape figures. */
export const seesScrapes = (v: AssistantViewer): boolean => v.admin || v.grants.includes("search");
/** One of the Billing tab's people — client_report keeps its Stripe billing. */
export const seesBilling = (v: AssistantViewer): boolean => v.admin || v.billing;

/** What the model is told when it answers someone who isn't an admin. */
export function scopeNote(v: AssistantViewer): string | null {
  if (v.admin) return null;
  const closed = [
    ...(seesBilling(v) ? [] : ["billing, invoices, MRR and payments"]),
    "commissions", "the team",
    // Said in the words people ask in (18 Nov: "How many agents are there in Dallas?" was searched for in conversations).
    ...(seesScrapes(v) ? [] : ["the agent database — how many agents or offices are in a place, an agent's sales or brokerage, top agents or brokerages — and scraping"]),
    ...(v.grants.includes("onboarding") ? [] : ["onboarding"]),
    "notifications",
  ];
  return (
    "This person is not a workspace admin: you have ONLY the tools for the parts of the OS switched on for them. Tools named " +
    "in the instructions above that you were not given are not available to this person — never try another tool in their place. " +
    `If they ask about something none of your tools covers — ${closed.join("; ")}; or any other area — say plainly in one ` +
    "sentence that it isn't available to them here (an admin can look), and never estimate it. A client report or overview " +
    "given to them leaves those parts out on purpose: never say they are zero."
  );
}
