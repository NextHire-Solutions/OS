import { test } from "node:test";
import assert from "node:assert/strict";

import type { PipelineEntry, PipelineStage } from "@/lib/tools/master-inbox/portals/stages-shared";
import { canonicalStageDefs, resolveStageDefs, type ClientStageRow } from "@/lib/tools/master-inbox/portals/stage-config";
import {
  abbrevUsd,
  groupByMonth,
  inRange,
  initials,
  messageText,
  panelFields,
  pipelineView,
  previewStages,
  rangeStart,
  salesVolumeOf,
  shortDate,
  sourceLabel,
} from "./model.ts";

/*
 * The preview shows a client's pipeline as the live portal holds it, drawn the
 * way the client's redesign asks: forward stages as columns, Nurture / Not a
 * Fit / No Response as tags.
 */

let n = 0;
function entry(stage: PipelineStage, over: Partial<PipelineEntry> = {}): PipelineEntry {
  n += 1;
  return {
    id: `e${n}`, stage, custom_stage_key: null, needs_replacement: false,
    lead_name: `Agent ${n}`, lead_email: `agent${n}@example.com`, lead_phone: null,
    current_brokerage: "Keller Williams", agent_profile_url: null, lead_location: null,
    introduced_at: "2026-10-05T14:00:00Z", lead_detail: null, campaign_name: null, thread_id: null,
    notes_log: [], assigned_team_member_id: null, assigned_team_member: null,
    fub_event_id: null, fub_pushed_at: null, fub_last_error: null, source: "BrokerStaffer",
    ...over,
  };
}
const withVolume = (v: string) => ({ lead_detail: { custom_fields: { "Sales Volume": v } } });

const NOW = new Date("2026-10-15T16:00:00Z"); // Thursday, noon Eastern

test("a real client: its forward stages are columns, Nurture / Not a Fit / No Response are tags, Interview Scheduled stays hidden", () => {
  const stages = previewStages(canonicalStageDefs({ feature_flags: {}, stage_label_overrides: {} }));
  assert.deepEqual(stages.filter((s) => s.role === "stage").map((s) => s.label), ["Introduction", "Phone Screen Scheduled", "Phone Screen", "Interview", "Hired"]);
  assert.deepEqual(stages.filter((s) => s.role === "tag").map((s) => s.label), ["Nurture", "Not a Fit", "No Response"]);
});

test("the client's own stage names and the Interview Scheduled flag carry over", () => {
  const stages = previewStages(canonicalStageDefs({ feature_flags: { interview_scheduled_stage: true }, stage_label_overrides: { introduction: "Interested", keep_warm: "Warm" } }));
  assert.equal(stages[0].label, "Interested");
  assert.ok(stages.some((s) => s.key === "interview_scheduled" && s.role === "stage"));
  assert.ok(stages.some((s) => s.label === "Warm" && s.role === "tag"));
});

test("the Demo portal's own stages: custom ones are columns, the two no-show stages are tags, hidden ones are gone", () => {
  const rows: ClientStageRow[] = [
    { key: "introduction", label: "Interested", color: null, sort_order: 0, kind: "canonical", canonical_stage: "introduction", hidden: false },
    { key: "custom_offer", label: "Offer Sent", color: "#0891b2", sort_order: 1, kind: "custom", canonical_stage: null, hidden: false },
    { key: "phone_screen", label: "Phone Screen", color: null, sort_order: 2, kind: "canonical", canonical_stage: "phone_screen", hidden: true },
    { key: "no_show", label: "No Response", color: null, sort_order: 3, kind: "canonical", canonical_stage: "no_show", hidden: false },
  ];
  const stages = previewStages(resolveStageDefs({ feature_flags: { manage_stages: true } }, rows));
  assert.deepEqual(stages.map((s) => [s.label, s.role]), [
    ["Interested", "stage"], ["Offer Sent", "stage"], ["No Response", "tag"], ["Phone screen no show", "tag"], ["Interview no show", "tag"],
  ]);
  assert.equal(stages[1].dot, "#0891b2", "a custom stage keeps its colour");
});

test("the board: forward stages only by default; the summary counts everyone, tags included", () => {
  const stages = previewStages(canonicalStageDefs({}));
  const entries = [entry("introduction", withVolume("$2,000,000")), entry("introduction"), entry("hired", withVolume("1500000")), entry("keep_warm"), entry("we_they_rejected")];
  const v = pipelineView(entries, stages, { range: "all", search: "", chip: null, now: NOW });
  assert.equal(v.shown.length, 5);
  assert.equal(v.totalVolume, 3_500_000);
  assert.deepEqual(v.columns.map((c) => [c.stage.key, c.entries.length]), [["introduction", 2], ["phone_screen_scheduled", 0], ["phone_screen", 0], ["interview", 0], ["hired", 1]]);
  assert.equal(v.columns[0].volume, 2_000_000);
  assert.equal(v.counts.get("keep_warm"), 1);
});

test("a chip narrows to its stage or tag; a tag's agents then show as its own column", () => {
  const stages = previewStages(canonicalStageDefs({}));
  const entries = [entry("introduction"), entry("keep_warm"), entry("keep_warm")];
  const tag = pipelineView(entries, stages, { range: "all", search: "", chip: "keep_warm", now: NOW });
  assert.equal(tag.shown.length, 2);
  assert.deepEqual(tag.columns.map((c) => [c.stage.label, c.entries.length]), [["Nurture", 2]]);
  assert.equal(tag.counts.get("introduction"), 1, "the other chips keep their counts");
  const unknown = pipelineView(entries, stages, { range: "all", search: "", chip: "interview_scheduled", now: NOW });
  assert.equal(unknown.shown.length, 3, "a chip for a stage the client does not show is ignored");
});

test("agents in a stage the client does not show stay out, as on the live board", () => {
  const stages = previewStages(canonicalStageDefs({}));
  const v = pipelineView([entry("interview_scheduled"), entry("introduction")], stages, { range: "all", search: "", chip: null, now: NOW });
  assert.equal(v.shown.length, 1);
});

test("search: name, email, office or phone", () => {
  const stages = previewStages(canonicalStageDefs({}));
  const entries = [entry("introduction", { lead_name: "Carlina Jones" }), entry("introduction", { current_brokerage: "Hester Group" }), entry("introduction", { lead_phone: "(678) 427-0510" })];
  const find = (q: string) => pipelineView(entries, stages, { range: "all", search: q, chip: null, now: NOW }).shown.length;
  assert.equal(find("carlina"), 1);
  assert.equal(find("HESTER"), 1);
  assert.equal(find("427-0510"), 1);
  assert.equal(find("  "), 3);
});

test("time ranges start on Eastern days; weeks start Monday", () => {
  assert.equal(rangeStart("week", NOW), "2026-10-12");
  assert.equal(rangeStart("month", NOW), "2026-10-01");
  assert.equal(rangeStart("3m", NOW), "2026-07-15");
  assert.equal(rangeStart("12m", NOW), "2025-10-15");
  assert.equal(rangeStart("all", NOW), null);
  // 02:00 UTC on the 16th is still Thursday the 15th in New York.
  assert.equal(rangeStart("week", new Date("2026-10-16T02:00:00Z")), "2026-10-12");
  // Sunday 11pm Eastern is last week; Monday 00:30 Eastern is this week.
  assert.equal(inRange("2026-10-12T03:00:00Z", "week", NOW), false);
  assert.equal(inRange("2026-10-12T04:30:00Z", "week", NOW), true);
  assert.equal(inRange(null, "week", NOW), false);
  assert.equal(inRange(null, "all", NOW), true);
  // January minus three months is October of the year before.
  assert.equal(rangeStart("3m", new Date("2026-01-20T17:00:00Z")), "2025-10-20");
});

test("the list: newest month first, newest agent first, undated last", () => {
  const a = entry("introduction", { introduced_at: "2026-09-02T15:00:00Z" });
  const b = entry("introduction", { introduced_at: "2026-10-09T15:00:00Z" });
  const c = entry("introduction", { introduced_at: "2026-10-01T04:30:00Z" }); // 1 Oct, 00:30 Eastern
  const d = entry("introduction", { introduced_at: null });
  const e = entry("introduction", { introduced_at: "2026-10-01T03:00:00Z" }); // 30 Sep, 11pm Eastern
  const groups = groupByMonth([a, b, c, d, e]);
  assert.deepEqual(groups.map((g) => g.label), ["October 2026", "September 2026", "No date"]);
  assert.deepEqual(groups[0].entries.map((x) => x.id), [b.id, c.id]);
  assert.deepEqual(groups[1].entries.map((x) => x.id), [e.id, a.id]);
});

test("dates: this year without the year, other years with it", () => {
  assert.equal(shortDate("2026-10-05T14:00:00Z", NOW), "Oct 5");
  assert.equal(shortDate("2025-12-30T14:00:00Z", NOW), "Dec 30, 2025");
  assert.equal(shortDate(null, NOW), "—");
});

test("source tag: the client's own agents say Client", () => {
  assert.equal(sourceLabel({ source: "Client Entry" }), "Client");
  assert.equal(sourceLabel({ source: "BrokerStaffer" }), "BrokerStaffer");
});

test("sales volume and its abbreviation read as the live board reads them", () => {
  assert.equal(salesVolumeOf({ lead_detail: { custom_fields: { "sales volume": "$2,314,500" } } }), 2_314_500);
  assert.equal(salesVolumeOf({ lead_detail: { custom_fields: { salesVolume: "n/a" } } }), null);
  assert.equal(salesVolumeOf({ lead_detail: null }), null);
  assert.equal(abbrevUsd(23_900_000), "$23.9M");
  assert.equal(abbrevUsd(412_000_000), "$412M");
  assert.equal(abbrevUsd(980_000), "$980K");
});

test("the agent panel: the lead's details, dollars formatted, no repeats of email/phone/company, links kept as links", () => {
  const fields = panelFields({ lead_detail: { custom_fields: {
    Email: "x@y.com", "Phone Number": "1", companyName: "KW", "Sales Volume": "2314500", "Buy-side": "$0",
    "MLS Affiliation": "GAMLS, FMLS", closedTransactions: 8, "Agent Profile": "https://example.com/a", nested: { a: 1 }, Empty: "",
  } } });
  assert.deepEqual(fields, [
    { label: "Sales Volume", value: "$2,314,500" },
    { label: "Buy-side", value: "$0" },
    { label: "MLS Affiliation", value: "GAMLS, FMLS" },
    { label: "Closed Transactions", value: "8" },
    { label: "Agent Profile", value: "https://example.com/a", href: "https://example.com/a" },
  ]);
});

test("an email as text: the reply without its quoted history; HTML tags removed, never rendered", () => {
  assert.equal(messageText("Happy to chat next week.\n\nOn Mon, Oct 5, 2026 at 9:41 AM Maria Lopez <maria@x.com> wrote:\n> Hi Carlina", null), "Happy to chat next week.");
  assert.equal(messageText("Sure.\n\nOn Mon, Oct 5, 2026 at 9:41 AM Maria Lopez <\nmaria@x.com> wrote:\n> Hi", null), "Sure.", "Gmail's two-line header");
  assert.equal(messageText("Thanks\n-----Original Message-----\nFrom: x", null), "Thanks");
  assert.equal(messageText(null, "<p>Hi&nbsp;Carlina,</p><p>Open to a call?</p><style>p{}</style><script>x()</script>"), "Hi Carlina,\n\nOpen to a call?");
  assert.equal(messageText("", "<div>a &lt;b&gt; &amp; c &#39;d&#x27;</div>"), "a <b> & c 'd'");
  assert.equal(messageText(null, null), "");
  assert.equal(messageText("On second thought, yes.", null), "On second thought, yes.", "a line starting 'On' at the top is the message itself");
});

/*
 * The shapes the mailbox actually stores (checked on 16 Oct, structure only):
 * our emails' text part has no line breaks and escaped "<"; replies quote in a
 * blockquote, Gmail's quote block, or under Outlook's header.
 */
test("an email as text: the stored shapes — the HTML's paragraphs win over a flattened text part", () => {
  const flatText = "Hey Kelly,Open to a call?Paisley GreenC21 Results";
  const html = "<p>Hey Kelly,</p><p>Open to a call?</p><p>Paisley Green<br>C21 Results</p>";
  assert.equal(messageText(flatText, html), "Hey Kelly,\n\nOpen to a call?\n\nPaisley Green\nC21 Results");
  const followUp = "<p>One more thing.</p><p>All the best,<br>Paisley</p><div>On Mon, Oct 12, 2026 12:47:42 PM Paisley Green &lt;p@x.com&gt; wrote:<br></div><blockquote><p>Hey Kelly,</p></blockquote>";
  assert.equal(messageText("One more thing.All the best,PaisleyOn Mon, Oct 12, 2026 12:47:42 PM Paisley Green &lt;p@x.com&gt; wrote: Hey Kelly,", followUp), "One more thing.\n\nAll the best,\nPaisley");
  const gmail = '<div dir="ltr">Sure, Tuesday works.</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 12, 2026 wrote:<br></div><blockquote>Hey</blockquote></div>';
  assert.equal(messageText("Sure, Tuesday works.\n\nOn Mon…", gmail), "Sure, Tuesday works.");
  const outlook = '<div>Thanks, call me Friday.</div><hr><div id="divRplyFwdMsg"><b>From:</b> Paisley<br><b>Sent:</b> Monday</div>';
  assert.equal(messageText(null, outlook), "Thanks, call me Friday.");
  assert.equal(messageText("Flat text only,On Tue, Oct 13, 2026 5:50 PM Paisley wrote: old", null), "Flat text only,", "no HTML: the flattened text is still cut at the quote");
});

test("initials", () => {
  assert.equal(initials("Carlina Jones"), "CJ");
  assert.equal(initials("Cher"), "C");
  assert.equal(initials("  "), "?");
  assert.equal(initials("Mary Ann van Dyke"), "MD");
});
