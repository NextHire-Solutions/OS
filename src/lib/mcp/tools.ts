import "server-only";

import { runAssistantTool, SYSTEM_PROMPT, TOOL_SCHEMA } from "@/lib/tools/assistant/engine";

import type { McpTool } from "./server.ts";

/*
 * What Claude gets through the connector (15 Oct): the OS Assistant's tools,
 * every one of them, and the Assistant's briefing.
 *
 * ONE SET OF TOOLS. The connector does not have its own: a tool added to the
 * Assistant (TOOL_SCHEMA + HANDLERS in tools/assistant/engine.ts) appears in
 * Claude on the next deploy, with the same read-only guard
 * (tools/assistant/read-only.ts) — so the Assistant page and Claude cannot
 * disagree about what the OS knows, and neither can write.
 *
 * ONE BRIEFING. SYSTEM_PROMPT is what the Assistant knows about the business
 * — the products, the vocabulary, which tool answers what, and every release
 * note. It goes to Claude twice: as the server's instructions, and as the
 * os_guide tool, because not every Claude client shows a server's
 * instructions to the model.
 */

const GUIDE_TOOL = "os_guide";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** "client_report" → "Client report". */
const titleOf = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");

export const INSTRUCTIONS =
  "You are connected to BrokerStaffer OS (os.brokerstaffer.com), the workspace that runs BrokerStaffer's " +
  "lead-generation business — its clients, their portals, billing, commissions, email campaigns, inboxes, " +
  "introductions and every conversation with a lead. This connection is READ-ONLY: you can look anything up, " +
  "but nothing can be sent, paused, billed or changed through it; when someone asks for an action, say where " +
  "in the OS it is done. If you need the briefing below again, call os_guide.\n\n" +
  SYSTEM_PROMPT;

export function mcpTools(): McpTool[] {
  const guide: McpTool = {
    name: GUIDE_TOOL,
    title: "BrokerStaffer OS guide",
    description:
      "Call this FIRST in a new conversation about BrokerStaffer. The full briefing: what each product is, the " +
      "vocabulary (client vs portal, lifecycle status, introductions), which tool answers which question, how to " +
      "answer, and every recent change to the OS with its date.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  };
  return [
    guide,
    ...TOOL_SCHEMA.map(({ function: f }) => ({
      name: f.name,
      title: titleOf(f.name),
      description: f.description,
      inputSchema: f.parameters as Record<string, unknown>,
      annotations: READ_ONLY,
    })),
  ];
}

export async function runMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === GUIDE_TOOL) return INSTRUCTIONS;
  return runAssistantTool(name, args);
}
