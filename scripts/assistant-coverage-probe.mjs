/*
 * What the assistant CANNOT answer.
 *
 * Nine curated tools cover a slice of 145 tables. Asserting the size of that
 * slice is worthless; asking it questions from outside and reading what it
 * says is not. A tool that answers "I can't" is working as designed — a tool
 * that invents an answer is the failure.
 */
import { runTurn } from "../src/lib/tools/assistant/engine.ts";
import { loadAssistantKey, openAiModel } from "../src/lib/tools/assistant/openai.ts";
const { apiKey, model } = await loadAssistantKey(process.env.MASTER_INBOX_WORKSPACE_ID ?? "");
const ask = openAiModel(apiKey, model);

const probes = [
  "Show me the actual reply text from the last lead who said they were interested",
  "What does the email sequence for 54 Realty's campaign actually say?",
  "Which offer is The Keyes Company selling?",
  "Which of our sending inboxes are bouncing the most?",
  "How much revenue is Douglas Elliman NYC worth per month?",
];
for (const q of probes) {
  const t = await runTurn([], q, ask);
  const tools = t.toolCalls.map((c) => c.name).join(" → ") || "none";
  console.log("─".repeat(62));
  console.log(`Q: ${q}`);
  console.log(`   tools: ${tools}`);
  console.log(`   ${t.answer.replace(/\s+/g, " ").slice(0, 230)}\n`);
}
