import "server-only";

import { clientOverviewTool, clientRankingsTool, findClientTool } from "./tools.ts";
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
      name: "client_overview",
      description:
        "Everything known about one client across all four products: inbox threads and portal pipeline, campaigns and reply rate, " +
        "Client Health targets and intros, and scraping. " +
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
        "Use activeOnly for what is running right now. If the client is not linked to Campaign Analytics the reply says " +
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
        "Follow-up reminders set on inbox threads, split into overdue and upcoming. Answers 'what have I missed'.",
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
        "A client's plan, campaign size, billing interval and anchor date, start date and targets. " +
        "NO PRICE OR REVENUE IS STORED in any of these systems — if asked what a client is worth, say that plainly " +
        "rather than inferring a figure from the plan name.",
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
];

export const SYSTEM_PROMPT = `You answer questions about a lead-generation business from its own data.

There are five products: Master Inbox (email threads, client portals, the reply agent), Campaign Analytics (EmailBison and Instantly campaigns), Client Health (targets and intros per client), Onboarding, and Agent Search (scraping real-estate agents).

How to answer:
- When a question names a client, resolve it with find_client first. If it returns candidates, ASK which one — never pick.
- Give the figures you were given. Do not estimate, extrapolate, or fill a gap with a plausible number.
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

The one genuine absence is PRICE and REVENUE — no figure exists in any of these systems, and a plan
name is not a number. Everything else the five products hold, a tool reaches.
The one genuine absence is PRICE and REVENUE — no figure exists in any of these systems, and a plan
name is not a number.`;

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  find_client: (a) => findClientTool(String(a.query ?? "")),
  client_overview: (a) => clientOverviewTool(String(a.client ?? "")),
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
 * Four covers the realistic chains — resolve a client, look it up, compare
 * against a ranking — with room to recover from one bad call. It is a stop,
 * not a target: without it a model that keeps re-calling the same tool spends
 * the user's money in a loop with nothing on screen.
 */
const MAX_ROUNDS = 4;

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
