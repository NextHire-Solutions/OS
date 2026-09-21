/*
 * A real turn: real model, real tools, real estate data.
 *
 * Everything up to the model was already tested with a scripted reply. This is
 * the hop that could not be checked without a key — whether the model actually
 * picks the right tool, and whether it respects the rule that a null is a gap
 * and not a zero.
 */
import { runTurn } from "../src/lib/tools/assistant/engine.ts";
import { loadAssistantKey, openAiModel } from "../src/lib/tools/assistant/openai.ts";

const { apiKey, model } = await loadAssistantKey(process.env.MASTER_INBOX_WORKSPACE_ID ?? "");
console.log(`model: ${model}\n`);
const ask = openAiModel(apiKey, model);

const questions = [
  "How is The Keyes Company doing?",
  "Which clients are furthest behind their intro target?",
  "What did we scrape for Brooklyn Group?",
];

let history = [];
for (const q of questions) {
  const started = Date.now();
  const turn = await runTurn(history, q, ask);
  console.log(`──────────────────────────────────────────────────────────────`);
  console.log(`Q: ${q}`);
  console.log(`   tools: ${turn.toolCalls.map((c) => `${c.name}(${Object.values(c.arguments).join(",")}) ${c.ms}ms`).join(" → ") || "none"}`);
  console.log(`   ${Math.round((Date.now() - started) / 100) / 10}s · ${turn.tokensPrompt + turn.tokensCompletion} tokens`);
  console.log(`\n${turn.answer}\n`);
  history = [...history, { role: "user", content: q }, { role: "assistant", content: turn.answer }];
}
