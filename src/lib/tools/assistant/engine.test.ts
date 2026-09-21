import assert from "node:assert/strict";
import { test, mock } from "node:test";

import { runTurn, type ModelFn, type ModelMessage } from "./engine.ts";

/*
 * The loop, against a scripted model.
 *
 * The model is injected precisely so this can run with no key, no network and
 * no cost — and because the loop is where the bugs live: feeding a tool result
 * back in the right shape, stopping, and not dying when a tool fails.
 */

function scripted(replies: Array<Parameters<ModelFn>[0] extends never ? never : Awaited<ReturnType<ModelFn>>>): {
  fn: ModelFn;
  seen: ModelMessage[][];
} {
  const seen: ModelMessage[][] = [];
  let i = 0;
  const fn: ModelFn = async (messages) => {
    seen.push(JSON.parse(JSON.stringify(messages)) as ModelMessage[]);
    return replies[Math.min(i++, replies.length - 1)];
  };
  return { fn, seen };
}

const answer = (content: string) => ({ content, toolCalls: [], tokensPrompt: 10, tokensCompletion: 5 });
const calls = (name: string, args: unknown) => ({
  content: null,
  toolCalls: [{ id: "call_1", name, arguments: JSON.stringify(args) }],
  tokensPrompt: 10,
  tokensCompletion: 5,
});

test("an answer with no tool call comes straight back", async () => {
  const { fn } = scripted([answer("Hello.")]);
  const r = await runTurn([], "hi", fn);
  assert.equal(r.answer, "Hello.");
  assert.equal(r.toolCalls.length, 0);
});

test("the system prompt and history are sent, question last", async () => {
  const { fn, seen } = scripted([answer("ok")]);
  await runTurn([{ role: "user", content: "earlier" }, { role: "assistant", content: "reply" }], "now", fn);
  const sent = seen[0];
  assert.equal(sent[0].role, "system");
  assert.equal(sent[1].content, "earlier");
  assert.equal(sent[2].content, "reply");
  assert.equal(sent[3].content, "now");
});

test("a tool result is fed back and the answer follows", async () => {
  const { fn, seen } = scripted([calls("find_client", { query: "keyes" }), answer("The Keyes Company.")]);
  const r = await runTurn([], "who is keyes", fn);
  assert.equal(r.answer, "The Keyes Company.");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "find_client");
  // The second call must carry the assistant's tool_calls AND the tool reply,
  // in that order — OpenAI rejects a tool message with no call preceding it.
  const second = seen[1];
  const assistantTurn = second[second.length - 2];
  const toolTurn = second[second.length - 1];
  assert.ok(assistantTurn.tool_calls?.length);
  assert.equal(toolTurn.role, "tool");
  assert.equal(toolTurn.tool_call_id, "call_1");
});

test("tokens accumulate across rounds", async () => {
  const { fn } = scripted([calls("find_client", { query: "x" }), answer("done")]);
  const r = await runTurn([], "q", fn);
  assert.equal(r.tokensPrompt, 20);
  assert.equal(r.tokensCompletion, 10);
});

/*
 * The one that matters most operationally. A product being down must become a
 * sentence the person can read, not a dead message: the model is TOLD the tool
 * failed and can say which part is unavailable.
 */
test("a failing tool is reported to the model, not thrown", async () => {
  const { fn, seen } = scripted([calls("no_such_tool", {}), answer("That lookup is unavailable.")]);
  const r = await runTurn([], "q", fn);
  assert.equal(r.answer, "That lookup is unavailable.");
  const toolTurn = seen[1][seen[1].length - 1];
  assert.match(String(toolTurn.content), /No tool named no_such_tool/);
});

test("malformed tool arguments do not crash the turn", async () => {
  const { fn } = scripted([
    { content: null, toolCalls: [{ id: "c", name: "find_client", arguments: "{not json" }], tokensPrompt: 1, tokensCompletion: 1 },
    answer("ok"),
  ]);
  const r = await runTurn([], "q", fn);
  assert.equal(r.answer, "ok");
  assert.deepEqual(r.toolCalls[0].arguments, {});
});

/*
 * Without a round cap, a model that keeps calling the same tool spends money
 * in a loop with nothing on screen. The cap ends the turn with a sentence.
 */
test("a model that only ever calls tools is stopped, with an explanation", async () => {
  const { fn } = scripted([calls("find_client", { query: "x" })]);
  const r = await runTurn([], "q", fn);
  assert.match(r.answer, /without reaching an answer/i);
  assert.equal(r.toolCalls.length, 4, "stops after MAX_ROUNDS, not forever");
});
