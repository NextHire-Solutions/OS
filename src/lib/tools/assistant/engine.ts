import {
  attributionTool, billingCyclesTool, businessPerformanceTool, campaignDetailTool, campaignKpisTool, clientSuccessTool,
  dataConsistencyTool, findAgentTool, offerPerformanceTool, onboardingClientTool, recentIntroductionsTool, replyTemplatesTool,
  searchConversationsTool, sendScheduleTool, workspaceHomeTool,
} from "./tools-phase8.ts";
import {
  billingOverviewTool, clientBillingTool, clientIntroductionTool, clientPortalsTool, clientRecordTool, commissionsTool,
  findLeadTool, listClientsTool, portalPipelineTool, teamTool,
} from "./tools-phase7.ts";
import "server-only";

import { clientOverviewTool, clientRankingsTool, findClientTool } from "./tools.ts";
import { clientReportTool } from "./tools-report.ts";
import {
  campaignsForClientTool,
  inboxActivityTool,
  replyAgentStatusTool,
  scrapeActivityTool,
} from "./tools-phase2.ts";
import { infrastructureHealthTool, onboardingPipelineTool } from "./tools-phase3.ts";
import {
  campaignCopyTool,
  clientCommercialsTool,
  inboxDeliverabilityTool,
  recentRepliesTool,
} from "./tools-phase4.ts";
import { agentDatabaseTool, clientReplyRatesTool, sendingVolumeTool } from "./tools-phase5.ts";
import { mlsCoverageTool, outcomesTool, remindersTool } from "./tools-phase6.ts";

/*
 * The tool-calling loop.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL CHOOSES A TOOL. IT NEVER WRITES A QUERY.
 *
 * Everything the assistant can learn about the estate goes through the three
 * functions below, each of which owns its joins and does its counting in the
 * database. The model's job is to pick one, read what comes back, and say it
 * in English — not to know that Analytics links to Master Inbox by
 * portal_client_id rather than by name.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL CALL IS INJECTED
 *
 * `runTurn` takes the model as an argument rather than reaching for OpenAI.
 * The loop — call, execute, feed back, repeat, stop — is the part with the
 * bugs in it, and it can then be tested against a scripted model with no key,
 * no network and no cost. `openAiModel()` below is the real one.
 */

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
  ms: number;
}

export interface TurnResult {
  answer: string;
  toolCalls: ToolCall[];
  tokensPrompt: number;
  tokensCompletion: number;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ModelReply {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  tokensPrompt: number;
  tokensCompletion: number;
}

export type ModelFn = (messages: ModelMessage[]) => Promise<ModelReply>;

/*
 * What the model is told it can do.
 *
 * The descriptions carry the WARNINGS, not just the shapes, because the model
 * is the thing that decides whether a null means "nothing" or "unknown", and
 * it only knows what these strings tell it.
 */
export const TOOL_SCHEMA = [
  {
    type: "function" as const,
    function: {
      name: "find_client",
      description:
        "Resolve a client name the user typed to the canonical client. Use this FIRST whenever a question names a client. " +
        "If it returns candidates instead of a match, the name is ambiguous — ask the user which one, do not pick.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The client name as the user typed it." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_report",
      description:
        "THE tool for 'how is <client> doing', 'give me a (full) report on <client>', 'account review', 'health of <client>'. " +
        "One call reads every product for that client — master record, Stripe, Campaign Analytics (last 30 days vs the 30 before " +
        "and vs the business average), the portal pipeline, Client Health (billing cycle, weekly volume, health score), reply labels, " +
        "the introduction setup and scrapes — and returns a verdict, attention items and strengths already computed. Write it up " +
        "in the CLIENT REPORT format; never recompute its numbers.",
      parameters: {
        type: "object",
        properties: { client: { type: "string", description: "Client name." } },
        required: ["client"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_overview",
      description:
        "A quick cross-product SNAPSHOT of one client (lifetime inbox, campaign and Client Health counts, scraping). For 'how is X doing' " +
        "or any report use client_report instead. " +
        "IMPORTANT: a null figure means that product is NOT LINKED to this client — it does not mean zero. The `missing` array " +
        "names those products. Say so plainly rather than reporting 0.",
      parameters: {
        type: "object",
        properties: { client: { type: "string", description: "Client name." } },
        required: ["client"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_rankings",
      description:
        "Rank clients by one of three performance signals. 'behind_target' compares intros booked this month against the " +
        "monthly target; 'gone_quiet' is days since any lead activity; 'stagnant_intros' is intros that have not moved. " +
        "These do not move together — a client can be ahead of target with every intro stale. Paused clients are excluded " +
        "from problem rankings because they are behind by arrangement. Set best:true for the strongest performers instead. " +
        "`notCovered` lists clients Client Health does not track at all, so they are absent from the ranking entirely.",
      parameters: {
        type: "object",
        properties: {
          signal: { type: "string", enum: ["behind_target", "gone_quiet", "stagnant_intros"] },
          limit: { type: "number", description: "How many to return, 1-50. Default 10." },
          best: { type: "boolean", description: "True for best performers, false/absent for worst." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "campaigns_for_client",
      description:
        "List a client's campaigns across both platforms, with status, leads, emails sent, replies and reply rate. " +
        "Includes each campaign's DAILY SEND LIMIT and daily new-lead limit — use this for any sending-limit question. Use activeOnly for what is running right now. If the client is not linked to Campaign Analytics the reply says " +
        "so — that is not the same as having no campaigns.",
      parameters: {
        type: "object",
        properties: {
          client: { type: "string" },
          activeOnly: { type: "boolean", description: "Only campaigns currently sending." },
        },
        required: ["client"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "scrape_activity",
      description:
        "Recent scraping runs — how many agents were found, how many had an email, how many were sent to a campaign. " +
        "Omit `client` for the latest runs across the whole business, which answers 'what did we scrape recently'. " +
        "24 of 59 clients are not linked to Agent Search; for those the reply says so rather than reporting none.",
      parameters: {
        type: "object",
        properties: {
          client: { type: "string", description: "Optional. Omit for the latest runs overall." },
          limit: { type: "number", description: "How many runs, 1-50. Default 10." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "inbox_activity",
      description:
        "How lead replies were classified over a period — Interested, Not Interested, Meetings Booked, Introduction and " +
        "the rest, with counts. Answers 'how is the inbox doing' and 'how many interested replies this month'.",
      parameters: {
        type: "object",
        properties: { days: { type: "number", description: "Look back this many days. Default 30." } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "outcomes",
      description:
        "What happened to the agents we introduced — the funnel from introduction through phone screen and interview to " +
        "hired, plus keep_warm, no_show and rejected. For the whole business or one client. This is the real result of " +
        "the work; replies and intros are upstream of it.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Look back this many days, 1-730. Default 90." },
          client: { type: "string", description: "Optional. Omit for the whole business." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mls_coverage",
      description:
        "Which MLS areas each monitored account is watching and how many agents each area holds — the MLS monitor and " +
        "courted-accounts view from Agent Search, with the last refresh status of each account.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reminders",
      description:
        "The inbox's follow-up reminders \u2014 set on Master Inbox conversations and shared by the whole team (not per person) \u2014 split into overdue and upcoming. Answers 'do I have any overdue reminders', 'which follow-ups are due', 'what have I missed'.",
      parameters: {
        type: "object",
        properties: { includeDone: { type: "boolean", description: "Include completed reminders." } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sending_volume",
      description:
        "How many emails went out and how many replies came back, BY WEEK — for the whole business or one client. " +
        "Answers 'how much did we send last week'. The newest week is marked partial because it is still running; " +
        "never compare it with a finished week without saying so.",
      parameters: {
        type: "object",
        properties: {
          weeks: { type: "number", description: "How many weeks back, 1-52. Default 6." },
          client: { type: "string", description: "Optional. Omit for the whole business." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_reply_rates",
      description:
        "Clients ranked by reply rate over a period, plus the overall rate across the business. Set best:true for the " +
        "strongest. Clients below a volume threshold are excluded because a rate on few sends is noise.",
      parameters: {
        type: "object",
        properties: {
          weeks: { type: "number", description: "1-52. Default 6." },
          best: { type: "boolean", description: "True for best, false/absent for worst." },
          limit: { type: "number", description: "1-50. Default 10." },
          minEmails: { type: "number", description: "Minimum emails in the window to qualify. Default 1000." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "agent_database",
      description:
        "The scraped agent database: how many agents and offices we hold, how many MLS areas, and the largest areas by " +
        "member count. This is every agent ever scraped, not a per-client figure.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "campaign_copy",
      description:
        "What a client's emails actually say — the sequence steps with subject and body — and which offer the campaigns " +
        "sell. A/B variants are omitted unless asked for. Bodies are truncated.",
      parameters: {
        type: "object",
        properties: {
          client: { type: "string" },
          includeVariants: { type: "boolean", description: "Include A/B variants of each step." },
        },
        required: ["client"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recent_replies",
      description:
        "The actual text of recent replies from leads. Filter by client, by label (Interested, Not Interested, " +
        "Introduction, Unsubscribe and so on), or both. Bodies are truncated; ask for few.",
      parameters: {
        type: "object",
        properties: {
          client: { type: "string", description: "Optional." },
          label: { type: "string", description: "Optional reply label, e.g. Interested." },
          limit: { type: "number", description: "1-20. Default 5." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "inbox_deliverability",
      description:
        "Which sending mailboxes bounce most, worst first, among those with enough volume for a rate to mean anything. " +
        "Answers 'which inboxes are hurting us'.",
      parameters: {
        type: "object",
        properties: {
          minSent: { type: "number", description: "Ignore inboxes below this lifetime send count. Default 200." },
          limit: { type: "number", description: "1-50. Default 10." },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_commercials",
      description:
        "A client's plan, campaign size, billing interval and anchor date, start date and targets, from Client Health. " +
        "For what a client PAYS (MRR, total spend, invoices) use client_billing — never infer money from the plan name. " +
        "Sending limits are per campaign: campaigns_for_client.",
      parameters: { type: "object", properties: { client: { type: "string" } }, required: ["client"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "onboarding_pipeline",
      description:
        "Where clients are in onboarding — new, assigned, campaign_launched, paused — and which have been waiting in a " +
        "pre-launch status too long. Answers 'who is stuck in onboarding'.",
      parameters: {
        type: "object",
        properties: { stalledDays: { type: "number", description: "Count as stalled after this many days. Default 14." } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "infrastructure_health",
      description:
        "The sending fleet: how many inboxes exist on each platform, how many are connected or failed, and the total " +
        "daily send capacity. Capacity is what the fleet COULD send in a day, not what it did.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reply_agent_status",
      description:
        "What the AI reply agent is set to and what it has done: mode, which clients it covers, drafts written, replies " +
        "held by the safety gate, leads qualified and handed over. Note `sent` counts drafts that went out INCLUDING ones " +
        "a person sent from the composer; an agent in shadow mode never sends by itself.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_record",
      description:
        "The client's MASTER RECORD \u2014 the source of truth for: status (active/onboarding/paused/churned) and since when; plan; sign-up, start, onboarding, pause and churn dates; salesperson, account manager and sender; point of contact; website and Zillow profile; markets (MLS and areas); billing schedule; targets and this billing cycle; its portals; who introductions are addressed to. Use for ANY question about who runs, sold or owns a client, its status or its dates. A client can have several portals \u2014 this is ONE client.",
      parameters: {"type": "object", "properties": {"client": {"type": "string"}}, "required": ["client"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_clients",
      description:
        "List clients from the master record, filtered by status ('active','onboarding','paused','churned'), account manager, salesperson, plan or market (MLS/area), with counts by status. Use THIS for 'which clients are paused/churned/active', 'how many active clients', 'which clients does <account manager> manage', 'who did <salesperson> sell' \u2014 NOT onboarding_pipeline, which is a different list. For ONE person's clients always pass their name as accountManager or salesperson: `total` is then their count. Status alone counts everyone.",
      parameters: {"type": "object", "properties": {"status": {"type": "string"}, "accountManager": {"type": "string"}, "salesperson": {"type": "string"}, "plan": {"type": "string"}, "market": {"type": "string"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_billing",
      description:
        "One client's money, from Stripe: MRR, total spend (all successful charges less refunds), subscription status and next charge, unpaid / past-due invoices, and recent invoices. Answers 'what does X pay', 'has X paid', 'is X behind on payment'.",
      parameters: {"type": "object", "properties": {"client": {"type": "string"}}, "required": ["client"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "billing_overview",
      description:
        "Revenue across the business, from Stripe: total MRR, clients ranked by MRR, all unpaid and past-due invoices with amounts, and which clients are not linked to Stripe. Answers 'what is our MRR', 'who owes us money', 'which invoices are past due'.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "commissions",
      description:
        "Commission payouts: who is owed what on a payout run (the 1st and 15th), per person and per client, with the rules. Omit `run` for the next/current run; pass YYYY-MM-01 or YYYY-MM-15 for another. Optionally one person by name.",
      parameters: {"type": "object", "properties": {"run": {"type": "string", "description": "YYYY-MM-01 or YYYY-MM-15"}, "person": {"type": "string"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "team",
      description:
        "The team: who is an admin or account manager (and how many active clients each manages), and the salespeople with their commission rate and active clients sold.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_introduction",
      description:
        "The INTRODUCTION email for a client \u2014 the message the Introduce button and the reply agent send when handing a lead to the client: its text (custom or standard), who is copied in, the address it is sent from, and \u2014 for clients whose people have territories \u2014 which person each campaign\u2019s leads go to. Not the campaign's cold email (that is campaign_copy).",
      parameters: {"type": "object", "properties": {"client": {"type": "string"}}, "required": ["client"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_portals",
      description:
        "A client's portals (a client can have one per market) and which campaign sends its new leads to which portal, with whether that was chosen automatically or by a person.",
      parameters: {"type": "object", "properties": {"client": {"type": "string"}}, "required": ["client"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "portal_pipeline",
      description:
        "What the client's portal pipeline shows today across all its portals: how many introduced agents are at each stage (introduction, phone screen, interview, hired, keep warm, no show, rejected), all time. Pass `stage` to list the agents in that stage.",
      parameters: {"type": "object", "properties": {"client": {"type": "string"}, "stage": {"type": "string"}}, "required": ["client"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_lead",
      description:
        "Find a lead \u2014 an AGENT we emailed, never a client \u2014 by email or name across Master Inbox: their conversations, which portal they were introduced into and their stage there.",
      parameters: {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "workspace_home",
      description:
        "The OS Home page: headline numbers for the recent window (emails sent, replies, reply rate, response time, with change vs the previous window) and whether each product is up. Answers 'how are we doing overall', 'is everything working'.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "business_performance",
      description:
        "The Performance page: the client base and its movement \u2014 clients by status, added and churned in the last 90 days, by plan, month by month (new, churned, revenue collected from Stripe), and revenue collected this month. Answers 'how many clients did we add / lose', 'revenue by month'.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "data_consistency",
      description:
        "The Consistency check: where the products disagree about clients (missing from a tool, status mismatches, broken links), with severity. Answers 'is our data in sync', 'what's out of step'. Report only.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "billing_cycles",
      description:
        "Client Health Bi-Weekly: who bills next and how many introductions each still owes in its current billing cycle (carry included). Pass withinDays to see only clients billing in that many days. Answers 'who bills this week and are they on track'.",
      parameters: {"type": "object", "properties": {"withinDays": {"type": "number"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "client_success",
      description:
        "Client Health's Client Success view: each client's account-health score (0\u201310), total hires and last hire date, weakest first. Answers 'which accounts are unhealthy', 'who has hired the most'.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "campaign_kpis",
      description:
        "Campaign Analytics' KPI band for a period \u2014 for the whole business or, with `client`, ONE client: emails sent, replies, positive replies, bounces and the rates, with the previous period of equal length alongside. Use for 'how did campaigns do last 30 days' and 'how are <client>'s campaigns doing'.",
      parameters: {"type": "object", "properties": {"client": {"type": "string", "description": "One client's KPIs; omit for the whole business"}, "period": {"type": "string", "description": "'7d', '30d' (default) or '90d'"}, "from": {"type": "string", "description": "YYYY-MM-DD, with `to`"}, "to": {"type": "string", "description": "YYYY-MM-DD, with `from`"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "attribution",
      description:
        "Campaign Analytics' Attribution: what the sending produced and how much can be credited \u2014 introductions and later outcomes traced back to campaigns, for a period.",
      parameters: {"type": "object", "properties": {"period": {"type": "string", "description": "'7d', '30d' (default) or '90d'"}, "from": {"type": "string", "description": "YYYY-MM-DD, with `to`"}, "to": {"type": "string", "description": "YYYY-MM-DD, with `from`"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "offer_performance",
      description:
        "Campaign Analytics' Copy & Offer: which OFFERS (and their campaigns) perform best \u2014 sends, replies and positive rates per offer, for a period.",
      parameters: {"type": "object", "properties": {"period": {"type": "string", "description": "'7d', '30d' (default) or '90d'"}, "from": {"type": "string", "description": "YYYY-MM-DD, with `to`"}, "to": {"type": "string", "description": "YYYY-MM-DD, with `from`"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_schedule",
      description:
        "Campaign Analytics' Schedule: what is due to go out over the next three days, per campaign/day. Answers 'how much are we sending tomorrow'.",
      parameters: {"type": "object", "properties": {}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "campaign_detail",
      description:
        "One campaign in full by its name (or part of it): status, settings and limits, the sequence steps with how each step is doing, and recent activity.",
      parameters: {"type": "object", "properties": {"campaign": {"type": "string"}}, "required": ["campaign"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "onboarding_client",
      description:
        "One client's Onboarding: its stage, which onboarding steps are done or pending, lead count, deliveries and replies, whether onboarding was paid, and any open Stripe payment links.",
      parameters: {"type": "object", "properties": {"client": {"type": "string"}}, "required": ["client"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find_agent",
      description:
        "Look an agent up in the scraped agent database (Agent Search) by name, email or licence number: brokerage/office, location, sales volume, transactions, experience.",
      parameters: {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_conversations",
      description:
        "Search the text of inbox messages (replies from leads and our emails) for words or a phrase, newest first, with an excerpt and which portal the conversation belongs to. Answers 'did anyone mention X', 'find the email where\u2026'.",
      parameters: {"type": "object", "properties": {"text": {"type": "string"}, "days": {"type": "number", "description": "How far back, default 90, max 365"}}, "required": ["text"]},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reply_templates",
      description:
        "The inbox's saved reply templates (names, categories, a preview). Pass `query` to read matching templates in full (matches name, category or subject). Each client's introduction template is named \"Intro Macro - <client>\"; for what an introduction actually says, prefer client_introduction.",
      parameters: {"type": "object", "properties": {"query": {"type": "string"}}},
    },
  },
  {
    type: "function" as const,
    function: {
      name: "recent_introductions",
      description:
        "Agents recently introduced to clients (the portal pipeline): who, to which client/portal, when, and the stage they are at now, plus counts per portal. Default the last 14 days; optionally one client.",
      parameters: {"type": "object", "properties": {"days": {"type": "number"}, "client": {"type": "string"}}},
    },
  },
];

export const SYSTEM_PROMPT = `You answer questions about a lead-generation business from its own data.

There are five products: Master Inbox (email threads, client portals, the reply agent), Campaign Analytics (EmailBison and Instantly campaigns), Client Health (targets and intros per client), Onboarding, and Agent Search (scraping real-estate agents). On top of them sits the OS master client record (status, people, dates, markets, portals, introductions), Stripe billing (MRR, spend, invoices) and commissions.

Every OS screen has a tool: Home (workspace_home), Performance (business_performance), Consistency (data_consistency), Client Health's Bi-Weekly and Client Success (billing_cycles, client_success), Campaign Analytics' KPIs, Attribution, Copy & Offer, Schedule and one campaign (campaign_kpis, attribution, offer_performance, send_schedule, campaign_detail), Onboarding per client (onboarding_client), the agent database (find_agent), inbox text and templates (search_conversations, reply_templates) and recent introductions. Look before saying something is not tracked.

A CLIENT can have several PORTALS (one per market — Properties & Estates has Boston and Florida). Client-level questions — status, people, billing, commissions, introductions, portals — use client_record, list_clients, client_billing, billing_overview, commissions, client_introduction, client_portals, portal_pipeline. If find_client offers several portals of ONE client, answer client-level questions for the client instead of asking.

How to answer:
- When a question names a client, resolve it with find_client first. If it returns candidates, ASK which one — never pick.
- Client names often look like a person's name: "Jeff Cook" is the client Jeff Cook Real Estate, not a lead. When a name could be a client, try find_client before find_lead. Who a client's leads are introduced to — including by territory or campaign — is client_introduction.
- Give the figures you were given. Do not estimate, extrapolate, or fill a gap with a plausible number.
- Every fact about the business — a name, a figure, a date, a status — must come from a tool result in THIS turn or from an earlier answer in this conversation. A follow-up asking for something not already shown ("and who is their account manager?") needs the tool again. Never answer from memory or from the examples in these instructions; they are illustrations, not data.
- A null is not a zero. Null means the product is not linked to that client and the number is unknown; say that plainly.
- Say which product and period a figure came from, so it can be checked.
- Be brief and concrete. Lead with the answer, then the supporting numbers. Tables for more than three rows.
- If the tools cannot answer the question, say what is missing rather than guessing around it.

ANSWER THE QUESTION ASKED, OR SAY YOU CANNOT.
A near-miss is worse than a refusal. If a tool returns something ADJACENT to what was asked, do not
present it as the answer — name the difference and say the real figure is unavailable.
Asked which OFFER a client sells, their billing PLAN is not the answer.
Asked for revenue, their intro target is not the answer.
Asked which inboxes bounce most, a fleet-wide connected count is not the answer.
You may add adjacent information after saying plainly that the question itself cannot be answered.

Distinguish what you cannot see from what does not exist. Your inability to reach something is a fact
about your tools, never a fact about the business. Asked about courted accounts you once replied that
the system does not store them — it does; you simply cannot read it. Phrase such an answer as not
having a way to look it up, in your own words, and point at the product that holds it.

Money IS available: MRR, total spend and invoices come from Stripe (client_billing, billing_overview) and
payouts from commissions. A plan name is still not a price — never infer one from it.
Status lists come from list_clients (the master record), never from onboarding_pipeline.

CLIENT REPORT. For "how is X doing", "full report", "account review" or "health of X": call client_report ONCE, straight away with the name as given — it finds the client itself (no find_client first; if it returns candidates, ask which). Write it up exactly in this shape — a readable report, not a list of fields:

## <Client> — <verdict>
At most three sentences a manager can act on: why the verdict, then the two or three decisive numbers WITH their comparison (introductions this billing cycle delivered vs required; last 30 days vs the 30 before; reply rate vs the business average), then money in a few words.

### Introductions & results
A table: Metric | Value | Context — introductions this billing cycle (delivered / required, next billing date), last 30 days (vs previous 30), all time, hires (all time, last 90 days), last introduction.

### Pipeline
A table from pipelineAllTime (Stage | Agents | Share), as given; one sentence on what it shows.

### Campaigns — last 30 days
A table: Metric | Client | Business average — sent and replies (business average "—"), then reply rate, positive rate, bounce rate (leave out a row whose value is null). Then the active campaigns as a table: Campaign | Sent (lifetime) | Reply rate | Daily limit.

### Weekly trend
A table of every week given (Week of | Emails | Replies | Intros | Reply rate), marking the running week "(so far)".

### Replies — last 30 days
One line with the label counts, largest first.

### Account
Bullets: status (since), plan, client since, account manager, salesperson, MRR, total spend, next charge, who introductions go to.

### Needs attention
Every item of "attention", high first, as "**Area** — issue. *Next:* nextStep" (use the tool's nextStep; do not invent a vaguer one). If there are none, say so.

### Going well
The "strengths".

End with one italic line: the sources and periods, and anything in "unavailable".

A paused or churned client's verdict is its status; its report is about whether campaigns and billing are stopped to match, so keep it short: skip the billing-cycle row, and if campaignsLast30Days has a "note", print the note instead of its rates.
Rules for reports: use the tool's numbers exactly; money as $1,234.56, rates as percentages with two decimals, dates as 5 Oct 2026; never print a null as 0 — leave the row out or say "not linked"; do not add sections the data does not support.`;

const periodArgs = (a: Record<string, unknown>) => ({
  period: typeof a.period === "string" ? a.period : undefined,
  from: typeof a.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.from) ? a.from : undefined,
  to: typeof a.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.to) ? a.to : undefined,
});

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  find_client: (a) => findClientTool(String(a.query ?? "")),
  client_overview: (a) => clientOverviewTool(String(a.client ?? "")),
  client_report: (a) => clientReportTool(String(a.client ?? "")),
  campaigns_for_client: (a) =>
    campaignsForClientTool(String(a.client ?? ""), { activeOnly: a.activeOnly === true }),
  scrape_activity: (a) =>
    scrapeActivityTool({
      client: typeof a.client === "string" && a.client ? a.client : undefined,
      limit: typeof a.limit === "number" ? a.limit : undefined,
    }),
  inbox_activity: (a) => inboxActivityTool({ days: typeof a.days === "number" ? a.days : undefined }),
  reply_agent_status: () => replyAgentStatusTool(),
  onboarding_pipeline: (a) =>
    onboardingPipelineTool({ stalledDays: typeof a.stalledDays === "number" ? a.stalledDays : undefined }),
  infrastructure_health: () => infrastructureHealthTool(),
  campaign_copy: (a) => campaignCopyTool(String(a.client ?? ""), { includeVariants: a.includeVariants === true }),
  recent_replies: (a) =>
    recentRepliesTool({
      client: typeof a.client === "string" && a.client ? a.client : undefined,
      label: typeof a.label === "string" && a.label ? a.label : undefined,
      limit: typeof a.limit === "number" ? a.limit : undefined,
    }),
  inbox_deliverability: (a) =>
    inboxDeliverabilityTool({
      minSent: typeof a.minSent === "number" ? a.minSent : undefined,
      limit: typeof a.limit === "number" ? a.limit : undefined,
    }),
  client_commercials: (a) => clientCommercialsTool(String(a.client ?? "")),
  sending_volume: (a) =>
    sendingVolumeTool({
      weeks: typeof a.weeks === "number" ? a.weeks : undefined,
      client: typeof a.client === "string" && a.client ? a.client : undefined,
    }),
  client_reply_rates: (a) =>
    clientReplyRatesTool({
      weeks: typeof a.weeks === "number" ? a.weeks : undefined,
      best: a.best === true,
      limit: typeof a.limit === "number" ? a.limit : undefined,
      minEmails: typeof a.minEmails === "number" ? a.minEmails : undefined,
    }),
  agent_database: () => agentDatabaseTool(),
  outcomes: (a) =>
    outcomesTool({
      days: typeof a.days === "number" ? a.days : undefined,
      client: typeof a.client === "string" && a.client ? a.client : undefined,
    }),
  mls_coverage: () => mlsCoverageTool(),
  reminders: (a) => remindersTool({ includeDone: a.includeDone === true }),
  workspace_home: () => workspaceHomeTool(),
  business_performance: () => businessPerformanceTool(),
  data_consistency: () => dataConsistencyTool(),
  billing_cycles: (a) => billingCyclesTool({ withinDays: typeof a.withinDays === "number" ? a.withinDays : undefined }),
  client_success: () => clientSuccessTool(),
  campaign_kpis: (a) => campaignKpisTool({ ...periodArgs(a), client: typeof a.client === "string" && a.client ? a.client : undefined }),
  attribution: (a) => attributionTool(periodArgs(a)),
  offer_performance: (a) => offerPerformanceTool(periodArgs(a)),
  send_schedule: () => sendScheduleTool(),
  campaign_detail: (a) => campaignDetailTool(String(a.campaign ?? "")),
  onboarding_client: (a) => onboardingClientTool(String(a.client ?? "")),
  find_agent: (a) => findAgentTool(String(a.query ?? "")),
  search_conversations: (a) => searchConversationsTool({ text: String(a.text ?? ""), days: typeof a.days === "number" ? a.days : undefined }),
  reply_templates: (a) => replyTemplatesTool(typeof a.query === "string" && a.query ? a.query : undefined),
  recent_introductions: (a) => recentIntroductionsTool({ days: typeof a.days === "number" ? a.days : undefined, client: typeof a.client === "string" && a.client ? a.client : undefined }),
  client_record: (a) => clientRecordTool(String(a.client ?? "")),
  list_clients: (a) => listClientsTool({
    status: typeof a.status === "string" && a.status ? a.status : undefined,
    accountManager: typeof a.accountManager === "string" && a.accountManager ? a.accountManager : undefined,
    salesperson: typeof a.salesperson === "string" && a.salesperson ? a.salesperson : undefined,
    plan: typeof a.plan === "string" && a.plan ? a.plan : undefined,
    market: typeof a.market === "string" && a.market ? a.market : undefined,
  }),
  client_billing: (a) => clientBillingTool(String(a.client ?? "")),
  billing_overview: () => billingOverviewTool(),
  commissions: (a) => commissionsTool({
    run: typeof a.run === "string" && /^\d{4}-\d{2}-(01|15)$/.test(a.run) ? a.run : undefined,
    person: typeof a.person === "string" && a.person ? a.person : undefined,
  }),
  team: () => teamTool(),
  client_introduction: (a) => clientIntroductionTool(String(a.client ?? "")),
  client_portals: (a) => clientPortalsTool(String(a.client ?? "")),
  portal_pipeline: (a) => portalPipelineTool(String(a.client ?? ""), typeof a.stage === "string" && a.stage ? a.stage : undefined),
  find_lead: (a) => findLeadTool(String(a.query ?? "")),
  client_rankings: (a) =>
    clientRankingsTool({
      signal: a.signal as "behind_target" | "gone_quiet" | "stagnant_intros" | undefined,
      limit: typeof a.limit === "number" ? a.limit : undefined,
      best: a.best === true,
    }),
};

/*
 * How many times the model may call tools before it has to answer.
 *
 * Five covers the realistic chains — resolve a client, read its record, its billing, compare
 * against a ranking — with room to recover from one bad call. It is a stop,
 * not a target: without it a model that keeps re-calling the same tool spends
 * the user's money in a loop with nothing on screen.
 */
const MAX_ROUNDS = 5;

export async function runTurn(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  question: string,
  model: ModelFn,
): Promise<TurnResult> {
  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];

  const toolCalls: ToolCall[] = [];
  let tokensPrompt = 0;
  let tokensCompletion = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await model(messages);
    tokensPrompt += reply.tokensPrompt;
    tokensCompletion += reply.tokensCompletion;

    if (!reply.toolCalls.length) {
      return {
        answer: reply.content ?? "",
        toolCalls,
        tokensPrompt,
        tokensCompletion,
      };
    }

    messages.push({
      role: "assistant",
      content: reply.content,
      tool_calls: reply.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of reply.toolCalls) {
      const started = Date.now();
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }

      const handler = HANDLERS[call.name];
      /*
       * A failed tool is REPORTED TO THE MODEL, not thrown. The model can then
       * say "Client Health was unreachable" — which is a true answer — instead
       * of the whole message dying and the person seeing a red box with no
       * idea which part failed.
       */
      let result: unknown;
      if (!handler) {
        result = { error: `No tool named ${call.name}.` };
      } else {
        try {
          result = await handler(args);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      toolCalls.push({ name: call.name, arguments: args, result, ms: Date.now() - started });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  /*
   * Out of rounds with no answer. Saying so is the honest outcome — the
   * alternative is a final unguarded model call whose reply nobody bounded.
   */
  return {
    answer:
      "I looked this up several times without reaching an answer. Try asking for one thing at a time — " +
      "a single client, or a single ranking.",
    toolCalls,
    tokensPrompt,
    tokensCompletion,
  };
}
