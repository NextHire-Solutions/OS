import { test } from "node:test";
import assert from "node:assert/strict";

import type { PipelineEntry, PipelineStage } from "@/lib/tools/master-inbox/portals/stages-shared";
import { canonicalStageDefs, resolveStageDefs, type ClientStageRow } from "@/lib/tools/master-inbox/portals/stage-config";
import {
  abbrevUsd,
  formatPhone,
  furthestStages,
  groupByMonth,
  inRange,
  initials,
  listPage,
  managedStages,
  messageText,
  panelFields,
  pipelineView,
  placeEntry,
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

test("the board: every agent in a forward column — a tagged one at the furthest stage on record, tag under the name", () => {
  const stages = previewStages(canonicalStageDefs({}));
  const warm = entry("keep_warm");
  const unfit = entry("we_they_rejected");
  const entries = [entry("introduction", withVolume("$2,000,000")), entry("introduction"), entry("hired", withVolume("1500000")), warm, unfit];
  const v = pipelineView(entries, stages, { range: "all", search: "", chip: null, now: NOW }, { [unfit.id]: "interview" });
  assert.equal(v.shown.length, 5);
  assert.equal(v.totalVolume, 3_500_000);
  assert.deepEqual(v.columns.map((c) => [c.stage.key, c.entries.length]), [["introduction", 3], ["phone_screen_scheduled", 0], ["phone_screen", 0], ["interview", 1], ["hired", 1]]);
  assert.equal(v.columns[0].volume, 2_000_000);
  assert.equal(v.placement.get(warm.id)?.tag?.label, "Nurture");
  assert.equal(v.placement.get(warm.id)?.stage.key, "introduction", "no history: the first stage");
  assert.equal(v.placement.get(unfit.id)?.stage.key, "interview", "history: the furthest stage");
  assert.equal(v.counts.get("keep_warm"), 1);
  assert.equal(v.counts.get("introduction"), 3, "a stage counts the tagged agents at it");
  assert.equal(v.counts.get("interview"), 1);
});

test("a stage chip shows its column; a tag chip keeps the columns and shows only that tag's agents", () => {
  const stages = previewStages(canonicalStageDefs({}));
  const a = entry("introduction"), b = entry("keep_warm"), c = entry("keep_warm");
  const tag = pipelineView([a, b, c], stages, { range: "all", search: "", chip: "keep_warm", now: NOW }, { [c.id]: "phone_screen" });
  assert.equal(tag.shown.length, 2);
  assert.deepEqual(tag.columns.filter((x) => x.entries.length).map((x) => [x.stage.label, x.entries.length]), [["Introduction", 1], ["Phone Screen", 1]]);
  assert.equal(tag.columns.length, 5, "every forward column stays");
  assert.equal(tag.counts.get("introduction"), 2, "the other chips keep their counts");
  const stage = pipelineView([a, b, c], stages, { range: "all", search: "", chip: "introduction", now: NOW });
  assert.deepEqual(stage.columns.map((x) => [x.stage.key, x.entries.length]), [["introduction", 3]]);
  const unknown = pipelineView([a, b, c], stages, { range: "all", search: "", chip: "interview_scheduled", now: NOW });
  assert.equal(unknown.shown.length, 3, "a chip for a stage the client does not show is ignored");
});

test("the furthest stage on record, from the portal's stage history", () => {
  const tagged = new Set(["e1", "e2", "e3"]);
  const events = [
    { entry_id: "e1", event_type: "introduction" }, { entry_id: "e1", event_type: "interview" }, { entry_id: "e1", event_type: "phone_screen" },
    { entry_id: "e1", event_type: "we_they_rejected" },
    { entry_id: "e2", event_type: "introduction" }, { entry_id: "e2", event_type: "no_show" },
    { entry_id: "x9", event_type: "hired" }, { entry_id: null, event_type: "hired" },
  ];
  assert.deepEqual(furthestStages(events, tagged), { e1: "interview", e2: "introduction" }, "tags are not stages; untagged and orphaned events are ignored");
});

test("a recorded stage the client does not show falls back to the nearest earlier one it does", () => {
  const stages = previewStages(canonicalStageDefs({})); // no Interview Scheduled
  const e = entry("no_show");
  const p = placeEntry(e, stages, { [e.id]: "interview_scheduled" });
  assert.equal(p?.stage.key, "phone_screen");
  assert.equal(p?.tag?.key, "no_show");
  assert.equal(p?.fromHistory, true);
  assert.equal(placeEntry(entry("hired"), stages, {})?.tag, null, "a forward stage is its own column, no tag");
  assert.equal(placeEntry(entry("interview_scheduled"), stages, {}), null, "a stage the client does not show: not placed (as on the live board)");
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

test("phones as the design writes them; anything else as it came", () => {
  assert.equal(formatPhone("6788844475"), "(678) 884-4475");
  assert.equal(formatPhone("678.341.4921"), "(678) 341-4921");
  assert.equal(formatPhone("+1 (404) 555-0182"), "(404) 555-0182");
  assert.equal(formatPhone("1-404-555-0182"), "(404) 555-0182");
  assert.equal(formatPhone("+44 20 7946 0958"), "+44 20 7946 0958");
  assert.equal(formatPhone("ext 12"), "ext 12");
  assert.equal(formatPhone("  "), null);
  assert.equal(formatPhone(null), null);
});

test("the list in pages of 50: newest first, months kept together, each month counted whole", () => {
  const at = (iso: string) => entry("introduction", { introduced_at: iso });
  const entries = [
    ...Array.from({ length: 9 }, (_, i) => at(`2026-10-0${i + 1}T15:00:00Z`)),
    ...Array.from({ length: 27 }, (_, i) => at(`2026-09-${String(i + 1).padStart(2, "0")}T15:00:00Z`)),
    ...Array.from({ length: 31 }, (_, i) => at(`2026-08-${String(i + 1).padStart(2, "0")}T15:00:00Z`)),
  ];
  const p1 = listPage(entries, 1);
  assert.deepEqual([p1.page, p1.pages, p1.from, p1.to, p1.total], [1, 2, 1, 50, 67]);
  assert.deepEqual(p1.groups.map((g) => [g.label, g.rows.length, g.monthTotal]), [["October 2026", 9, 9], ["September 2026", 27, 27], ["August 2026", 14, 31]]);
  assert.equal(p1.groups[0].rows[0].introduced_at, "2026-10-09T15:00:00Z", "newest first");
  const p2 = listPage(entries, 2);
  assert.deepEqual([p2.from, p2.to], [51, 67]);
  assert.deepEqual(p2.groups.map((g) => [g.label, g.rows.length, g.monthTotal]), [["August 2026", 17, 31]]);
  assert.equal(listPage(entries, 99).page, 2, "past the end: the last page");
  assert.deepEqual([listPage([], 1).from, listPage([], 1).to, listPage([], 1).pages], [0, 0, 1]);
});

test("Manage stages (Demo): a tag added there is a tag; hidden stages are still listed for editing", () => {
  const rows: ClientStageRow[] = [
    { key: "introduction", label: "Introduction", color: null, sort_order: 0, kind: "canonical", canonical_stage: "introduction", hidden: false },
    { key: "phone_screen", label: "Phone call", color: null, sort_order: 1, kind: "canonical", canonical_stage: "phone_screen", hidden: true },
    { key: "custom_apw2pau5", label: "Invited to sales meeting", color: "#e23a3a", sort_order: 2, kind: "custom", canonical_stage: null, hidden: false },
    { key: "custom_tag_ab12cd34", label: "Top producer", color: "#0f766e", sort_order: 3, kind: "custom", canonical_stage: null, hidden: false },
    { key: "keep_warm", label: "Nurture", color: null, sort_order: 4, kind: "canonical", canonical_stage: "keep_warm", hidden: false },
  ];
  const defs = resolveStageDefs({}, rows);
  const shown = previewStages(defs);
  assert.ok(!shown.some((s) => s.key === "phone_screen"), "hidden: not on the board");
  assert.equal(shown.find((s) => s.key === "custom_tag_ab12cd34")?.role, "tag");
  assert.equal(shown.find((s) => s.key === "custom_apw2pau5")?.role, "stage", "the live portal's own custom stages stay stages");
  const all = managedStages(defs);
  assert.deepEqual(all.map((s) => [s.key, s.role, s.hidden]), [
    ["introduction", "stage", false],
    ["phone_screen", "stage", true],
    ["custom_apw2pau5", "stage", false],
    ["custom_tag_ab12cd34", "tag", false],
    ["keep_warm", "tag", false],
    ["phone_screen_no_show", "tag", false],
    ["interview_no_show", "tag", false],
  ]);
  assert.equal(all.find((s) => s.key === "keep_warm")?.dot, shown.find((s) => s.key === "keep_warm")?.dot, "drawn in the design's colours, as on the board");
});
