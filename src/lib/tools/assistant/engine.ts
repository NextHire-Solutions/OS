import "server-only";

import { clientOverviewTool, clientRankingsTool, findClientTool } from "./tools.ts";
import {
  campaignsForClientTool,
  inboxActivityTool,
  replyAgentStatusTool,
  scrapeActivityTool,
} from "./tools-phase2.ts";

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
- If the tools cannot answer the question, say what is missing rather than guessing around it.`;

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
