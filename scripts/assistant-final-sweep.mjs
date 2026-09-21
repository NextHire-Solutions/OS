import { runTurn } from "../src/lib/tools/assistant/engine.ts";
import { loadAssistantKey, openAiModel } from "../src/lib/tools/assistant/openai.ts";
const { apiKey, model } = await loadAssistantKey(process.env.MASTER_INBOX_WORKSPACE_ID ?? "");
const ask = openAiModel(apiKey, model);
for (const q of [
  "How many people have we actually hired for clients?",
  "Who are our courted accounts and which MLS areas do we cover?",
  "Do I have any overdue reminders?",
  "What is Douglas Elliman NYC worth per month?",
]) {
  const t = await runTurn([], q, ask);
  console.log("─".repeat(58));
  console.log(`Q: ${q}`);
  console.log(`   tools: ${t.toolCalls.map(c=>c.name).join(" → ") || "NONE"}`);
  console.log(`   ${t.answer.replace(/\s+/g," ").slice(0,300)}\n`);
}
