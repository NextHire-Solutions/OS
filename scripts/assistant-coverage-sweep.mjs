/*
 * A wider sweep, across areas no probe has touched yet.
 *
 * The standard is not "does it reply" — it is whether the reply is TRUE, or an
 * honest refusal. Every earlier sweep found a bug, so this one assumes it will
 * too and is written to make a wrong answer visible rather than plausible.
 */
import { runTurn } from "../src/lib/tools/assistant/engine.ts";
import { loadAssistantKey, openAiModel } from "../src/lib/tools/assistant/openai.ts";
const { apiKey, model } = await loadAssistantKey(process.env.MASTER_INBOX_WORKSPACE_ID ?? "");
const ask = openAiModel(apiKey, model);

const probes = [
  "How many emails did we send last week in total?",
  "What is our overall reply rate across all clients?",
  "Which client has the best reply rate?",
  "How many agents do we have in the database?",
  "Which MLS areas are we covering?",
  "Who are our courted accounts?",
  "Compare The Keyes Company and 54 Realty",
  "Is anything broken right now that I should know about?",
];
for (const q of probes) {
  const t = await runTurn([], q, ask);
  console.log("─".repeat(60));
  console.log(`Q: ${q}`);
  console.log(`   tools: ${t.toolCalls.map((c) => c.name).join(" → ") || "NONE"}`);
  console.log(`   ${t.answer.replace(/\s+/g, " ").slice(0, 260)}\n`);
}
