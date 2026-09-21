import { runTurn } from "../src/lib/tools/assistant/engine.ts";
import { loadAssistantKey, openAiModel } from "../src/lib/tools/assistant/openai.ts";
const { apiKey, model } = await loadAssistantKey(process.env.MASTER_INBOX_WORKSPACE_ID ?? "");
const ask = openAiModel(apiKey, model);
for (const q of [
  "Who is stuck in onboarding?",
  "How much can we send per day?",
  "What did we scrape for RE/MAX Pacific?",
]) {
  const t0 = Date.now();
  const t = await runTurn([], q, ask);
  console.log("─".repeat(64));
  console.log(`Q: ${q}`);
  console.log(`   ${t.toolCalls.map(c=>c.name).join(" → ") || "no tools"} · ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
  console.log(t.answer.split("\n").filter(Boolean).slice(0,9).join("\n") + "\n");
}
