import "server-only";

import { handlersFor, SYSTEM_PROMPT, toolSchemaFor } from "@/lib/tools/assistant/engine";
import { scopeNote, type AssistantViewer } from "@/lib/tools/assistant/viewer";

import { actionsFor, actionTools, isActionName, runConnectorAction } from "./actions/index.ts";
import type { McpTool } from "./server.ts";

/*
 * What Claude gets through the connector (15 Oct): the OS Assistant's tools and the Assistant's briefing.
 *
 * ONE SET OF READ TOOLS. The connector does not have its own: a tool added to the Assistant (TOOL_SCHEMA + HANDLERS in
 * tools/assistant/engine.ts) appears in Claude on the next deploy, with the same read-only guard — so the Assistant page
 * and Claude cannot disagree about what the OS knows. For each person, the Assistant's own rule (viewer.ts): an admin
 * gets every tool, anyone else only those their switches open (25 Nov: the connector can be opened to people by name).
 *
 * ACTIONS (25 Nov): a few, each previewed then confirmed (actions/core.ts), switched on one by one (OS_MCP_ACTIONS) and
 * offered only to the people who may do the same on the OS screen. With none switched on, the connector is exactly as
 * read-only as before.
 *
 * ONE BRIEFING. SYSTEM_PROMPT goes to Claude twice: as the server's instructions, and as the os_guide tool, because not
 * every Claude client shows a server's instructions to the model.
 */

export type ConnectorViewer = AssistantViewer;

const GUIDE_TOOL = "os_guide";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** "client_report" → "Client report". */
const titleOf = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");

const OPENING =
  "You are connected to BrokerStaffer OS (os.brokerstaffer.com), the workspace that runs BrokerStaffer's " +
  "lead-generation business — its clients, their portals, billing, commissions, email campaigns, inboxes, " +
  "introductions and every conversation with a lead. ";

const READ_ONLY_LINE =
  "This connection is READ-ONLY: you can look anything up, but nothing can be sent, paused, billed or changed " +
  "through it; when someone asks for an action, say where in the OS it is done. ";

function actionsLine(names: string[]): string {
  return (
    `You can look anything up, and take ONLY these actions: ${names.join(", ")}. Every action takes two calls. First ` +
    "call it WITHOUT `confirm`: nothing changes, and you get a preview and a code. Tell the person exactly what the " +
    "preview says and ask them to confirm. Only after they clearly say yes in this chat, call it again with the SAME " +
    "arguments and `confirm` set to that code. Never confirm on your own, never reuse a code, and get a separate yes " +
    "for each action. If a call comes back `refused`, nothing was done: say so and why. Anything not in that list " +
    "(billing among it) is done in the OS: say where. "
  );
}

/** The briefing for this person: what they can do, the Assistant's knowledge, and (not an admin) what is closed. */
export function instructionsFor(v: ConnectorViewer): string {
  const acts = actionsFor(v).map((s) => s.name);
  const note = scopeNote(v);
  return (
    OPENING + (acts.length ? actionsLine(acts) : READ_ONLY_LINE) +
    "If you need the briefing below again, call os_guide.\n\n" + SYSTEM_PROMPT + (note ? `\n\n${note}` : "")
  );
}

export function mcpTools(v: ConnectorViewer): McpTool[] {
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
    ...toolSchemaFor(v).map(({ function: f }) => ({
      name: f.name,
      title: titleOf(f.name),
      description: f.description,
      inputSchema: f.parameters as Record<string, unknown>,
      annotations: READ_ONLY,
    })),
    ...actionTools(v),
  ];
}

export async function runMcpTool(name: string, args: Record<string, unknown>, v: ConnectorViewer): Promise<unknown> {
  if (name === GUIDE_TOOL) return instructionsFor(v);
  if (isActionName(name)) return runConnectorAction(name, args, v);
  const handler = handlersFor(v)[name];
  if (!handler) throw new Error(`No tool named ${name}.`);
  return handler(args);
}
