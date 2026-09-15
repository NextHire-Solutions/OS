import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstNameOf,
  hasIntroDetails,
  introTemplateName,
  missingIntroFields,
  renderIntroMacroTemplate,
} from "./intro-macro.ts";

const CLIENT = {
  name: "JPAR Iron Horse Real Estate",
  contactName: "Nicole Collins",
  contactRole: "Team Leader",
  brokerage: "JPAR Iron Horse Real Estate",
};

/*
 * The wording, pinned.
 *
 * Every client onboarded so far has this text stored in `reply_templates`.
 * If an edit here changes it, the button and those stored rows disagree —
 * so the expected string is written out in full rather than assembled from
 * the same pieces the implementation uses.
 */
const EXPECTED =
  "Hey {{lead.name}},\n\n" +
  "I'd like to introduce you to Nicole Collins, Team Leader at JPAR Iron Horse Real Estate\n\n" +
  "Nicole, I recently connected with {{lead.first_name}}, who can be reached directly at " +
  "{{lead.phone_number}} and is currently with {{lead.company}}.\n\n" +
  "{{lead.first_name}}, Nicole will be in touch directly to learn more about your business " +
  "and discuss the opportunity in greater detail.\n\n" +
  "I hope you have a productive conversation!\n\n" +
  "Best,\n{{sender.name}}\nTalent Acquisition | JPAR Iron Horse Real Estate";

test("the macro reads exactly as the stored templates do", () => {
  assert.equal(renderIntroMacroTemplate(CLIENT), EXPECTED);
});

test("the lead's values stay as placeholders, the client's do not", () => {
  const out = renderIntroMacroTemplate(CLIENT);
  for (const token of ["{{lead.name}}", "{{lead.first_name}}", "{{lead.phone_number}}", "{{lead.company}}", "{{sender.name}}"]) {
    assert.ok(out.includes(token), `${token} must survive for insert-time substitution`);
  }
  assert.equal(/\{\{client/.test(out), false, "the client's values are already filled in");
});

test("an empty brokerage falls back to the client's own name", () => {
  const out = renderIntroMacroTemplate({ ...CLIENT, brokerage: "" });
  assert.ok(out.includes("Team Leader at JPAR Iron Horse Real Estate"));
  assert.ok(out.endsWith("Talent Acquisition | JPAR Iron Horse Real Estate"));
});

test("the brokerage, not our name, signs the message off", () => {
  const out = renderIntroMacroTemplate({ ...CLIENT, brokerage: "Douglas Elliman NYC" });
  assert.ok(out.endsWith("Talent Acquisition | Douglas Elliman NYC"));
});

test("the first name is the first word, and an explicit one wins", () => {
  assert.equal(firstNameOf("Nicole Collins"), "Nicole");
  assert.equal(firstNameOf("  Amy   Lee "), "Amy");
  assert.equal(firstNameOf(null), "");
  const out = renderIntroMacroTemplate({ ...CLIENT, contactName: "Maria del Carmen Ruiz", contactFirstName: "Mari" });
  assert.ok(out.includes("Mari, I recently connected with"));
  assert.ok(out.includes("introduce you to Maria del Carmen Ruiz"));
});

test("missing fields are named, and brokerage is not one of them", () => {
  assert.deepEqual(missingIntroFields({ ...CLIENT, contactName: "", contactRole: "" }), ["contact name", "their role"]);
  assert.deepEqual(missingIntroFields({ ...CLIENT, contactRole: "   " }), ["their role"]);
  assert.deepEqual(missingIntroFields({ ...CLIENT, brokerage: null }), [], "brokerage has a fallback");
  assert.equal(hasIntroDetails(CLIENT), true);
  assert.equal(hasIntroDetails({ ...CLIENT, contactName: null }), false);
});

test("the stored template's name is how it is found again", () => {
  assert.equal(introTemplateName("54 Realty"), "Intro Macro - 54 Realty");
});
