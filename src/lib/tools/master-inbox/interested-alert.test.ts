import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INTERESTED_ALERTS_FROM, SWEEP_WINDOW_MS, alertText, isExcludedClient, isInterestedLabel, slackEscape, snippetOf, sweepSince,
} from "./interested-alert.ts";

test("only the label Interested triggers it — exactly, any case", () => {
  for (const n of ["Interested", "interested", " INTERESTED "]) assert.equal(isInterestedLabel(n), true, n);
  for (const n of ["Not Interested", "Interested - follow up", "Introduction", "", null, undefined]) assert.equal(isInterestedLabel(n), false, String(n));
});

test("Demo Portal is never announced; every real client is", () => {
  assert.equal(isExcludedClient("Demo Portal"), true);
  assert.equal(isExcludedClient(" demo portal "), true);
  assert.equal(isExcludedClient("Wagner Real Estate Group"), false);
  assert.equal(isExcludedClient(null), false);
});

test("the sweep looks back half an hour — never before go-live", () => {
  const later = new Date(Date.parse(INTERESTED_ALERTS_FROM) + 5 * 3600_000);
  assert.equal(sweepSince(later), new Date(later.getTime() - SWEEP_WINDOW_MS).toISOString());
  const justAfter = new Date(Date.parse(INTERESTED_ALERTS_FROM) + 60_000);
  assert.equal(sweepSince(justAfter), INTERESTED_ALERTS_FROM, "nothing from before go-live");
});

test("the snippet: whitespace collapsed, cut at a word, nothing when there is nothing", () => {
  assert.equal(snippetOf("Sure,\n\n  tell me   more."), "Sure, tell me more.");
  const long = "word ".repeat(100);
  const s = snippetOf(long, 40)!;
  assert.ok(s.endsWith("…") && s.length <= 41, s);
  assert.ok(!s.slice(0, -1).endsWith(" "));
  assert.equal(snippetOf("   "), null);
  assert.equal(snippetOf(null), null);
});

test("a lead's words cannot become Slack markup", () => {
  assert.equal(slackEscape("<!channel> & <https://x.y|click>"), "&lt;!channel&gt; &amp; &lt;https://x.y|click&gt;");
});

test("the message: client, lead, contact, brokerage, campaign, reply and link", () => {
  const text = alertText({
    clientName: "Wagner Real Estate Group", leadName: "Laura Wilson", leadEmail: "laura@example.com", leadPhone: "(665) 234-1234",
    brokerage: "Legacy Realty Group", campaign: "Wagner + Seattle", snippet: "Sure, tell me more.",
    threadUrl: "https://os.brokerstaffer.com/inbox/all-email/abc",
  });
  assert.equal(text, [
    ":large_green_circle: *Interested* · Wagner Real Estate Group",
    "*Laura Wilson*",
    "laura@example.com · (665) 234-1234",
    "Brokerage: Legacy Realty Group",
    "Campaign: Wagner + Seattle",
    "> Sure, tell me more.",
    "<https://os.brokerstaffer.com/inbox/all-email/abc|Open the conversation>",
  ].join("\n"));
});

test("missing fields are left out — never 'null', never an empty line", () => {
  const text = alertText({ clientName: null, leadName: null, leadEmail: "jo@x.co", leadPhone: null, brokerage: " ", campaign: null, snippet: null, threadUrl: "https://os/t" });
  assert.equal(text, ":large_green_circle: *Interested* · No client\n*jo@x.co*\njo@x.co\n<https://os/t|Open the conversation>");
  assert.ok(!/null|undefined/.test(text));
});
