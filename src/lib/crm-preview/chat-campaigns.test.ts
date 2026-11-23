/*
 * The portal chat's guide follows the Campaigns switch (23 Nov, Campaigns on for every portal): where the page is the
 * real editor the assistant explains how to change the emails; elsewhere it still says coming soon and that our team
 * changes them. The rules it states are the editor's own (campaign-copy.ts COPY_RULES).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { helpText, CAMPAIGNS_HELP } = await import("./chat-tools.ts");
const { COPY_RULES } = await import("./campaign-copy.ts");

test("Campaigns on: how to change the emails, never 'coming soon' or 'our team does it'", () => {
  const t = helpText({ stages: [], campaignsOn: true }).join("\n");
  assert.ok(t.includes(CAMPAIGNS_HELP));
  assert.doesNotMatch(t, /coming soon/i);
  assert.doesNotMatch(t, /our team does it/);
  assert.match(t, /goes live straight away/);
});

test("Campaigns off (or not said): unchanged — coming soon, and our team changes the emails", () => {
  for (const d of [{ stages: [], campaignsOn: false }, { stages: [] }]) {
    const t = helpText(d).join("\n");
    assert.match(t, /- Campaigns: coming soon\./);
    assert.match(t, /our team does it with them/);
    assert.ok(!t.includes(CAMPAIGNS_HELP));
  }
});

test("the rules it states are the editor's own", () => {
  assert.match(CAMPAIGNS_HELP, new RegExp(`up to ${COPY_RULES.maxWords} words`));
  assert.match(CAMPAIGNS_HELP, new RegExp(`up to ${COPY_RULES.maxEmails} emails`));
  assert.doesNotMatch(CAMPAIGNS_HELP, /—|@/, "no em dash, no address");
});

test("Help's 'Can I change my emails?' follows the switch too (the page passes it through, as it does to the tour)", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("src/components/crm-preview/static-pages.tsx", "utf8");
  const shell = readFileSync("src/components/crm-preview/crm-preview.tsx", "utf8");
  const on = /export const EMAILS_ANSWER_ON = "([^"]+)"/.exec(page)?.[1] ?? "";
  assert.match(on, /^Yes\. Open Campaigns/);
  assert.match(on, /Save changes/, "the button's own words");
  assert.match(on, /go live straight away/);
  assert.doesNotMatch(on, /—|@/);
  assert.match(page, /faqFor\(campaignsOn\)\.filter/, "Help lists the answers for this portal");
  assert.match(page, /q: "Can I change my emails\?", a: "Yes\.\s+Chat with support, ask for a person/, "off: unchanged");
  assert.match(shell, /<HelpScreen [^\n]*campaignsOn=\{campaignsOn\}/);
  assert.match(shell, /<Tour [^\n]*campaignsOn=\{campaignsOn\}/);
});
