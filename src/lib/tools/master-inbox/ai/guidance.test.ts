import { test } from "node:test";
import assert from "node:assert/strict";

import { renderGuidance, EMPTY_GUIDANCE, type Guidance } from "./retrieval.ts";
import { renderUserPrompt } from "./reply.ts";

/*
 * What the agent is allowed to read, and where it sits in the prompt.
 *
 * These are the two properties that decide whether retrieval helps or hurts:
 *
 *   · when there is nothing to retrieve, the prompt must be EXACTLY what it was
 *     before this feature existed — no empty headings, no "no examples found",
 *     nothing for the model to reason about. A graceful fallback that still
 *     changes the prompt is not a fallback.
 *
 *   · when there IS something, the model must be told to copy the MANNER and
 *     not the MATTER. The old agent's worst observed failure was inventing a
 *     contact because an example contained one; example text without that
 *     instruction is a licence to plagiarise facts between conversations.
 */

const base: Guidance = { ...EMPTY_GUIDANCE };

const example = (over: Partial<Guidance["examples"][number]> = {}) => ({
  label: "Objection",
  inbound: "I'm happy where I am, thanks.",
  reply: "Totally fair — most of the people we work with were too when we first spoke.",
  quality: 0.8,
  score: 0.71,
  ...over,
});

test("nothing retrieved renders nothing at all", () => {
  assert.equal(renderGuidance(base), "");
  assert.equal(renderGuidance({ ...base, styleGuide: "", objectionPlaybook: "" }), "");
});

test("the style guide and the playbook are labelled as standing rules", () => {
  const out = renderGuidance({ ...base, styleGuide: "- Open with the first name" });
  assert.match(out, /HOUSE STYLE/);
  assert.match(out, /Open with the first name/);
  // No examples were given, so no example section may appear.
  assert.doesNotMatch(out, /REAL REPLIES/);

  const both = renderGuidance({ ...base, styleGuide: "- A", objectionPlaybook: "## They are happy" });
  assert.match(both, /OBJECTION PLAYBOOK/);
  assert.ok(both.indexOf("HOUSE STYLE") < both.indexOf("OBJECTION PLAYBOOK"), "style guide comes first");
});

test("examples carry the do-not-copy-the-facts instruction", () => {
  const out = renderGuidance({ ...base, examples: [example()], source: "embedding", poolSize: 1 });
  assert.match(out, /REAL REPLIES WE HAVE SENT/);
  assert.match(out, /Do NOT copy their facts/);
  assert.match(out, /names,\s*\n?companies, numbers and offers/);
  assert.match(out, /situation: Objection/);
  assert.match(out, /Totally fair/);
});

test("a long example is truncated rather than allowed to swallow the prompt", () => {
  const long = "x".repeat(5000);
  const out = renderGuidance({ ...base, examples: [example({ reply: long, inbound: long })], source: "embedding", poolSize: 1 });
  // 900 for the reply, 600 for the inbound — well under the whole 5,000.
  assert.ok(out.length < 3500, `guidance was ${out.length} characters`);
  assert.ok(!out.includes(long));
});

test("every example is shown, numbered, in the order retrieval ranked them", () => {
  const out = renderGuidance({
    ...base,
    examples: [example({ reply: "FIRST reply text here, long enough to survive." }), example({ reply: "SECOND reply text here, long enough." })],
    source: "embedding",
    poolSize: 2,
  });
  assert.match(out, /Precedent 1/);
  assert.match(out, /Precedent 2/);
  assert.ok(out.indexOf("FIRST reply") < out.indexOf("SECOND reply"));
});

/* ------------------------------------------------------- the prompt itself */

const draftInput = (guidance?: string) => ({
  provider: "openai" as const,
  apiKey: "unused",
  model: "gpt-4o-mini",
  systemPrompt: "SYSTEM",
  tone: "warm",
  responseLength: "medium" as const,
  temperature: 0.4,
  maxTokens: 800,
  leadName: "Larry",
  leadEmail: "larry@example.com",
  ourName: "Nicole",
  ourEmail: "nicole@example.com",
  subject: "Re: hello",
  conversation: [
    { direction: "outbound" as const, sentAt: "2026-01-01T00:00:00Z", body: "Our opener." },
    { direction: "inbound" as const, sentAt: "2026-01-02T00:00:00Z", body: "I'm happy where I am." },
  ],
  guidance,
});

test("the thread's own history is in the prompt, oldest first, with the last inbound marked", () => {
  const prompt = renderUserPrompt(draftInput());
  assert.match(prompt, /Conversation so far/);
  assert.ok(prompt.indexOf("Our opener.") < prompt.indexOf("I'm happy where I am."), "oldest first");
  assert.match(prompt, /most recent — reply to this/);
});

test("no guidance leaves the prompt byte-identical to the old behaviour", () => {
  const without = renderUserPrompt(draftInput());
  assert.equal(renderUserPrompt(draftInput(undefined)), without);
  assert.equal(renderUserPrompt(draftInput("")), without);
  assert.equal(renderUserPrompt(draftInput("   \n  ")), without);
});

test("guidance sits after the conversation and before the instruction to write", () => {
  const prompt = renderUserPrompt(draftInput("=== HOUSE STYLE ===\n- Open with the first name"));
  const conversation = prompt.indexOf("Conversation so far");
  const guidance = prompt.indexOf("HOUSE STYLE");
  const instruction = prompt.indexOf("Now write OUR reply");
  assert.ok(conversation !== -1 && guidance !== -1 && instruction !== -1);
  assert.ok(conversation < guidance, "the thread comes before the precedent");
  assert.ok(guidance < instruction, "the precedent is the last thing read before writing");
});
