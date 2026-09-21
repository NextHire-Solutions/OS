import { runTurn } from "../src/lib/tools/assistant/engine.ts";
import { loadAssistantKey, openAiModel } from "../src/lib/tools/assistant/openai.ts";
const { apiKey, model } = await loadAssistantKey(process.env.MASTER_INBOX_WORKSPACE_ID ?? "");
const ask = openAiModel(apiKey, model);
const qs = [
  "What did we scrape recently?",
  "How many interested replies did we get in the last 30 days?",
  "Which campaigns are running for 54 Realty right now?",
  "What is the reply agent set to?",
];
for (const q of qs) {
  const t0 = Date.now();
  const t = await runTurn([], q, ask);
  console.log("─".repeat(66));
  console.log(`Q: ${q}`);
  console.log(`   ${t.toolCalls.map(c=>c.name).join(" → ") || "no tools"} · ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`\n${t.answer.split("\n").filter(Boolean).slice(0,9).join("\n")}\n`);
}
