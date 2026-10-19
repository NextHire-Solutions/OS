import "server-only";

import { loadAssistantKey } from "@/lib/tools/assistant/openai";
import { env } from "@/lib/tools/master-inbox/env";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { readOnly } from "@/lib/tools/assistant/read-only";
import { loadAgentEntries, loadDncEntries, loadPipelineEntries, loadTeamMembers } from "@/lib/tools/master-inbox/portals/portal-data";
import { loadClientStageRows } from "@/lib/tools/master-inbox/portals/load-stages";
import { canonicalStageDefs, MANAGE_STAGES_FLAG, resolveStageDefs } from "@/lib/tools/master-inbox/portals/stage-config";
import { clientHasFeature } from "@/lib/tools/master-inbox/portals/feature-flags";
import { osTable } from "@/lib/clients/os-db";

import { CHAT_TOOLS, runTool, systemPrompt, type ChatTurn, type MarketTotals, type PortalChatData } from "./chat-tools.ts";
import { clientForPortal, type OsClientRow } from "./market-model.ts";
import { furthestStages, previewStages } from "./model.ts";

/*
 * The portal assistant (19 Oct): one portal's data, the tools in
 * chat-tools.ts, and OpenAI with the workspace's key — the same key the OS
 * assistant uses (openai.ts loadAssistantKey), not a new one. Its own call,
 * NOT openAiModel(): that one carries the OS assistant's tools, which read
 * every client.
 *
 * Reads only. The data is loaded exactly as the preview page loads it, for
 * the one portal the request names — after the route's access gate.
 */

/** One portal's data, as its preview page shows it. Null for no such portal. */
export async function loadPortalChatData(portalId: string): Promise<PortalChatData | null> {
  const admin = readOnly(createAdminSupabase());
  const { data: client } = await admin
    .from("clients")
    .select("id, name, slug, portal_token, stage_label_overrides, feature_flags")
    .eq("id", portalId)
    .maybeSingle();
  const c = client as { id: string; name: string | null; slug: string | null; portal_token: string | null; stage_label_overrides?: unknown; feature_flags?: unknown } | null;
  if (!c || c.slug === "unknown" || !c.portal_token) return null;

  const flags = c.feature_flags && typeof c.feature_flags === "object" && !Array.isArray(c.feature_flags) ? (c.feature_flags as Record<string, unknown>) : {};
  const overrides = c.stage_label_overrides && typeof c.stage_label_overrides === "object" ? (c.stage_label_overrides as Record<string, unknown>) : {};
  const stageClient = { feature_flags: flags, stage_label_overrides: overrides };
  const defs = clientHasFeature({ feature_flags: flags }, MANAGE_STAGES_FLAG)
    ? resolveStageDefs(stageClient, await loadClientStageRows(c.id))
    : canonicalStageDefs(stageClient);

  const [entries, agents, dnc, team, history, records] = await Promise.all([
    loadPipelineEntries(c.id),
    loadAgentEntries(c.id),
    loadDncEntries(c.id),
    loadTeamMembers(c.id),
    fetchAllRows<{ entry_id: string | null; event_type: string }>(({ from, to }) =>
      admin.from("pipeline_outcome_events").select("entry_id, event_type").eq("client_id", c.id).eq("voided", false).order("id").range(from, to),
    ).catch(() => []),
    osTable("os_clients").select("id, name, aliases, mi_client_id, mls_codes, orch_client_id, contact_name").then((r) => (r.data ?? []) as unknown as Array<OsClientRow & { contact_name: string | null }>),
  ]);
  const stages = previewStages(defs);
  const tagKeys = new Set(stages.filter((s) => s.role === "tag").map((s) => s.key));
  const tagged = new Set(entries.filter((e) => tagKeys.has(e.custom_stage_key ?? e.stage)).map((e) => e.id));
  const record = clientForPortal({ id: c.id, name: c.name ?? "" }, records) as (OsClientRow & { contact_name: string | null }) | null;
  return {
    portal: { id: c.id, name: c.name ?? "Unnamed client" },
    contactName: record?.contact_name?.trim() || null,
    stages,
    furthest: furthestStages(history, tagged),
    entries,
    agents,
    dnc,
    team,
    now: new Date(),
  };
}

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

const MAX_ROUNDS = 5;
const MAX_TOOL_CHARS = 12_000;

export interface ChatAnswer { reply: string; tools: string[]; tokens: number }

/** Answer the last turn, using only `data` (one portal) and the market totals for that same portal. */
export async function answer(turns: ChatTurn[], data: PortalChatData, marketTotals: () => Promise<MarketTotals>): Promise<ChatAnswer> {
  const workspaceId = env.WORKSPACE_ID;
  if (!workspaceId) throw new Error("This server has no workspace configured.");
  const { apiKey, model } = await loadAssistantKey(workspaceId);

  const messages: Message[] = [
    { role: "system", content: systemPrompt(data) },
    ...turns.map((t): Message => (t.role === "user" ? { role: "user", content: t.text } : { role: "assistant", content: t.text })),
  ];
  const used: string[] = [];
  let tokens = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools: CHAT_TOOLS, tool_choice: "auto", temperature: 0.2, max_tokens: 700 }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
      usage?: { total_tokens?: number };
    };
    tokens += body.usage?.total_tokens ?? 0;
    const msg = body.choices?.[0]?.message;
    const calls = msg?.tool_calls ?? [];
    if (!calls.length) return { reply: (msg?.content ?? "").trim() || "Sorry — I couldn't find an answer to that.", tools: used, tokens };
    messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    for (const c of calls) {
      used.push(c.function.name);
      const out = await runTool(c.function.name, c.function.arguments, data, marketTotals).catch((e) => ({ error: e instanceof Error ? e.message : "The tool failed." }));
      const text = JSON.stringify(out);
      messages.push({ role: "tool", tool_call_id: c.id, content: text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}…(cut)` : text });
    }
  }
  return { reply: "Sorry — that took too many steps. Could you ask it a simpler way?", tools: used, tokens };
}
