import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INBOX_COLUMNS,
  INBOX_DEFAULT_VISIBLE,
  INBOX_FACETS,
  NONE,
  NO_FILTERS,
  counter,
  emailbisonInbox,
  emailbisonType,
  facetChipLabel,
  facetOptions,
  facetValueLabel,
  facetValues,
  filterInboxes,
  filtersActive,
  inboxSortValue,
  instantlyInbox,
  instantlyType,
  latestStamp,
  sendersWithSends,
  statusTone,
  toggleValue,
  vendorOf,
  type InboxFilters,
  type InboxRow,
  type SenderEmailRecord,
} from "./inboxes.ts";

/*
 * The Inboxes page (13 Oct). The list is loaded once and everything after
 * that — search, six filters, a sort on every column — happens in the browser,
 * so these are the only place those rules are checked.
 *
 * Two failures matter more than the rest and have the most cases below:
 *   · "not known" turning into 0 or "No" on the way from the database, and
 *   · the Assigned walk stopping early and reporting "No" for inboxes it
 *     never looked at.
 */

/* ------------------------------------------------------------ fixtures --- */

const sender = (over: Partial<SenderEmailRecord> = {}): SenderEmailRecord => ({
  id: 1536,
  email: "nicole@realtypartnersnow.com",
  name: "Nicole Collins",
  provider: "google_workspace_oauth",
  status: "Connected",
  vendor: "Zapmail",
  tags: ["Google", "Nicole Pool", "p.Zapmail Google"],
  daily_limit: 10,
  warmup_enabled: true,
  lifetime_sent: 420,
  lifetime_bounced: 6,
  unique_replied: 9,
  synced_at: "2026-10-13T12:00:00+00:00",
  ...over,
});

const inbox = (over: Partial<InboxRow> = {}): InboxRow => ({
  id: 1,
  platform: "emailbison",
  email: "a@one.com",
  name: null,
  type: "Google",
  status: "Connected",
  dailyLimit: 10,
  sentAllTime: 100,
  repliedAllTime: 3,
  bouncedAllTime: 1,
  warmupEnabled: true,
  warmup3d: null,
  warmup7d: null,
  vendor: "Zapmail",
  tags: ["Nicole Pool"],
  assignedToCampaign: true,
  ...over,
});

const ROWS: InboxRow[] = [
  inbox({ id: 1, email: "amy@one.com", name: "Amy Stone", type: "Google", status: "Connected", vendor: "Zapmail", tags: ["Google", "Nicole Pool"], assignedToCampaign: true, sentAllTime: 500 }),
  inbox({ id: 2, email: "ben@one.com", name: "Ben Hill", type: "Google", status: "Not connected", vendor: "Zapmail", tags: ["Google", "Nicole Pool 2"], assignedToCampaign: false, sentAllTime: 20 }),
  inbox({ id: 3, email: "cara@two.com", name: null, type: "Custom SMTP", status: "Connected", vendor: "Maildoso", tags: ["Custom Mail Server", "Nicole Pool"], assignedToCampaign: true, sentAllTime: 0 }),
  inbox({ id: 4, email: "dan@two.com", name: "Dan AMY Ross", type: "Custom SMTP", status: "Failed", vendor: null, tags: [], assignedToCampaign: false, sentAllTime: null }),
  inbox({ id: "eve@three.com", platform: "instantly", email: "eve@three.com", name: "Eve Lane", type: "Google", status: null, vendor: null, tags: ["Nicole Pool"], assignedToCampaign: null, sentAllTime: 75 }),
];

const only = (over: Partial<InboxFilters>): InboxFilters => ({ ...NO_FILTERS, ...over });
const ids = (rows: InboxRow[]) => rows.map((r) => r.id);

/* ------------------------------------------------- database → table row --- */

test("a counter that is not known stays unknown — it never becomes 0", () => {
  assert.equal(counter(null), null);
  assert.equal(counter(undefined), null);
  assert.equal(counter(""), null);
  assert.equal(counter("  "), null);
  assert.equal(counter(Number.NaN), null);
  assert.equal(counter("n/a"), null);
  // A real zero is a fact and is kept.
  assert.equal(counter(0), 0);
  assert.equal(counter(4821), 4821);
  // A bigint sum can arrive as text.
  assert.equal(counter("4821"), 4821);
  assert.equal(counter("0"), 0);
});

test("connection types read the same on both platforms", () => {
  assert.equal(emailbisonType("google_workspace_oauth"), "Google");
  assert.equal(emailbisonType("microsoft_oauth"), "Microsoft");
  assert.equal(emailbisonType("custom"), "Custom SMTP");
  assert.equal(emailbisonType("smtp"), "SMTP");
  assert.equal(instantlyType(2), "Google");
  assert.equal(instantlyType(3), "Microsoft");
  assert.equal(instantlyType(1), "Custom SMTP");
});

test("a type nobody has seen yet shows under its own name, and a missing one is unknown", () => {
  assert.equal(emailbisonType("zoho_oauth"), "zoho_oauth");
  assert.equal(instantlyType(99), "Provider 99");
  assert.equal(emailbisonType(null), null);
  assert.equal(emailbisonType("  "), null);
  assert.equal(instantlyType(null), null);
  assert.equal(instantlyType(undefined), null);
});

test("the vendor is read from the p. tag, by name alone", () => {
  assert.equal(vendorOf(["Google", "Nicole Pool", "p.Zapmail Google"]), "Zapmail");
  assert.equal(vendorOf(["p.Mission Inbox Custom"]), "Mission Inbox");
  // Pool tags are who runs an inbox, not who sold it.
  assert.equal(vendorOf(["Nicole Pool", "LeadGenJay"]), null);
  assert.equal(vendorOf([]), null);
  assert.equal(vendorOf(null), null);
});

test("an EmailBison inbox becomes a row", () => {
  assert.deepEqual(emailbisonInbox(sender(), new Set([1536])), {
    id: 1536,
    platform: "emailbison",
    email: "nicole@realtypartnersnow.com",
    name: "Nicole Collins",
    type: "Google",
    status: "Connected",
    dailyLimit: 10,
    sentAllTime: 420,
    repliedAllTime: 9,
    bouncedAllTime: 6,
    warmupEnabled: true,
    warmup3d: null,
    warmup7d: null,
    vendor: "Zapmail",
    tags: ["Google", "Nicole Pool", "p.Zapmail Google"],
    assignedToCampaign: true,
  });
});

test("an inbox that has never been counted shows nothing, not zeros", () => {
  const row = emailbisonInbox(
    sender({
      name: "  ", provider: null, status: null, vendor: null, tags: null, daily_limit: null,
      warmup_enabled: null, lifetime_sent: null, lifetime_bounced: null, unique_replied: null,
    }),
    new Set(),
  );
  assert.equal(row.name, null);
  assert.equal(row.type, null);
  assert.equal(row.status, null);
  assert.equal(row.vendor, null);
  assert.deepEqual(row.tags, []);
  assert.equal(row.dailyLimit, null);
  assert.equal(row.sentAllTime, null);
  assert.equal(row.repliedAllTime, null);
  assert.equal(row.bouncedAllTime, null);
  assert.equal(row.warmupEnabled, null);
});

test("warmup switched off is a fact, and is kept apart from not known", () => {
  assert.equal(emailbisonInbox(sender({ warmup_enabled: false }), null).warmupEnabled, false);
  assert.equal(emailbisonInbox(sender({ warmup_enabled: null }), null).warmupEnabled, null);
});

test("the warmup scores are never invented", () => {
  const row = emailbisonInbox(sender(), new Set([1536]));
  assert.equal(row.warmup3d, null);
  assert.equal(row.warmup7d, null);
});

test("assigned is Yes or No only when the send history was read", () => {
  assert.equal(emailbisonInbox(sender({ id: 7 }), new Set([7])).assignedToCampaign, true);
  assert.equal(emailbisonInbox(sender({ id: 7 }), new Set([8])).assignedToCampaign, false);
  // The history could not be read: unknown for everyone, not "No".
  assert.equal(emailbisonInbox(sender({ id: 7 }), null).assignedToCampaign, null);
});

test("an Instantly account becomes a row, with what Instantly does not report left unknown", () => {
  const row = instantlyInbox(
    { email: "eve@three.com", first_name: "Eve", last_name: "Lane", provider_code: 2, daily_limit: 30, tags: ["Nicole Pool"], synced_at: null },
    { email: "eve@three.com", sent: 1200, bounced: "14", replied: 22 },
  );
  assert.deepEqual(row, {
    id: "eve@three.com",
    platform: "instantly",
    email: "eve@three.com",
    name: "Eve Lane",
    type: "Google",
    status: null,
    dailyLimit: 30,
    sentAllTime: 1200,
    repliedAllTime: 22,
    bouncedAllTime: 14,
    warmupEnabled: null,
    warmup3d: null,
    warmup7d: null,
    vendor: null,
    tags: ["Nicole Pool"],
    assignedToCampaign: null,
  });
});

test("an Instantly account with nothing synced has no totals, not zeros", () => {
  const account = { email: "x@y.com", first_name: null, last_name: " ", provider_code: null, daily_limit: null, tags: null, synced_at: null };
  for (const stats of [undefined, { email: "x@y.com", sent: null, bounced: null, replied: null }]) {
    const row = instantlyInbox(account, stats);
    assert.equal(row.sentAllTime, null);
    assert.equal(row.repliedAllTime, null);
    assert.equal(row.bouncedAllTime, null);
    assert.equal(row.name, null);
    assert.equal(row.type, null);
    assert.deepEqual(row.tags, []);
  }
});

test("the latest sync time is the newest one, whatever order they come in", () => {
  assert.equal(latestStamp(["2026-10-13T09:00:00+00:00", "2026-10-13T12:00:00+00:00", "2026-10-12T23:00:00+00:00"]), "2026-10-13T12:00:00+00:00");
  // Compared as instants, not as text: 08:00-05:00 is later than 12:00Z.
  assert.equal(latestStamp(["2026-10-13T12:00:00Z", "2026-10-13T08:00:00-05:00"]), "2026-10-13T08:00:00-05:00");
  assert.equal(latestStamp([null, undefined, "not a date"]), null);
  assert.equal(latestStamp([]), null);
});

/* ------------------------------------------------------ the Assigned walk --- */

/**
 * A stand-in for the send history: one entry per email sent, newest first,
 * answered the way the route's query answers — the newest `limit` rows that
 * belong to the inboxes asked about.
 */
function history(sends: number[]) {
  const reads: Array<{ ids: number[]; returned: number }> = [];
  let running = 0;
  let peak = 0;
  const newest = async (asked: number[], limit: number) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 1));
    const want = new Set(asked);
    const page = sends.filter((s) => want.has(s)).slice(0, limit);
    reads.push({ ids: asked, returned: page.length });
    running--;
    return page;
  };
  return { newest, reads, peak: () => peak };
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

test("finds every inbox that has sent, and none that has not", async () => {
  // 1 and 2 send today; 3 sent long ago; 4 and 5 never.
  const h = history([1, 2, 1, 2, 1, 2, 3]);
  const found = await sendersWithSends([1, 2, 3, 4, 5], h.newest, { limit: 4 });
  assert.deepEqual(sorted(found), [1, 2, 3]);
});

test("a busy inbox cannot hide a quiet one behind a full page", async () => {
  // Inbox 1 has 50 newer sends than inbox 2's only one. Reading a single page
  // and stopping would call inbox 2 unassigned.
  const h = history([...Array(50).fill(1), 2]);
  const found = await sendersWithSends([1, 2, 3], h.newest, { limit: 10 });
  assert.deepEqual(sorted(found), [1, 2]);
  // The second read asks only about the inboxes not yet seen.
  assert.deepEqual(h.reads[1].ids, [2, 3]);
});

test("each inbox whose history is buried is still reached, one read at a time", async () => {
  // Four inboxes that stopped one after another, each with a page-full of
  // sends newer than the next one's last.
  const h = history([...Array(5).fill(1), ...Array(5).fill(2), ...Array(5).fill(3), 4]);
  const found = await sendersWithSends([1, 2, 3, 4, 5], h.newest, { limit: 5 });
  assert.deepEqual(sorted(found), [1, 2, 3, 4]);
  assert.deepEqual(h.reads.map((r) => r.ids), [[1, 2, 3, 4, 5], [2, 3, 4, 5], [3, 4, 5], [4, 5]]);
});

test("a short page ends it: one read when everything fits", async () => {
  const h = history([1, 2, 2]);
  const found = await sendersWithSends([1, 2, 3], h.newest, { limit: 1000 });
  assert.deepEqual(sorted(found), [1, 2]);
  assert.equal(h.reads.length, 1);
});

test("a page that is exactly full is read past, not trusted", async () => {
  // Three sends, a limit of three: the page is full, so it proves nothing
  // about inbox 3 until the next read comes back short.
  const h = history([1, 1, 2, 3]);
  const found = await sendersWithSends([1, 2, 3], h.newest, { limit: 3 });
  assert.deepEqual(sorted(found), [1, 2, 3]);
});

test("inboxes that never sent cost one read and are reported as not found", async () => {
  const h = history([]);
  const found = await sendersWithSends([1, 2, 3], h.newest, { limit: 10 });
  assert.equal(found.size, 0);
  assert.equal(h.reads.length, 1);
});

test("no inboxes, no reads", async () => {
  const h = history([1, 2]);
  assert.equal((await sendersWithSends([], h.newest)).size, 0);
  assert.equal(h.reads.length, 0);
});

test("asks about a bounded number of inboxes at a time, a few groups at once", async () => {
  const inboxIds = Array.from({ length: 95 }, (_, i) => i + 1);
  // Every third inbox has sent.
  const sends = inboxIds.filter((id) => id % 3 === 0).flatMap((id) => [id, id]);
  const h = history(sends);
  const found = await sendersWithSends(inboxIds, h.newest, { chunk: 10, limit: 4, parallel: 3 });

  assert.deepEqual(sorted(found), inboxIds.filter((id) => id % 3 === 0));
  assert.ok(h.reads.every((r) => r.ids.length <= 10), "a read never names more than one group");
  assert.ok(h.peak() <= 3, `at most 3 reads at once, saw ${h.peak()}`);
  assert.ok(h.peak() > 1, "the groups are read side by side");
  // Every inbox was asked about at least once.
  assert.deepEqual([...new Set(h.reads.flatMap((r) => r.ids))].sort((a, b) => a - b), inboxIds);
});

test("agrees with a plain count on a large uneven history", async () => {
  // A fixed pseudo-random history: 400 inboxes, a few very busy, many silent.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const inboxIds = Array.from({ length: 400 }, (_, i) => i + 1);
  const sends: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const r = rand();
    // Skewed: most sends come from the first few inboxes; ids over 250 never send.
    sends.push(1 + Math.floor(r * r * r * 250));
  }
  const truth = [...new Set(sends)].sort((a, b) => a - b);
  const h = history(sends);
  const found = await sendersWithSends(inboxIds, h.newest, { chunk: 60, limit: 50, parallel: 4 });
  assert.deepEqual(sorted(found), truth);
  assert.ok(truth.length > 50 && truth.length < inboxIds.length, "the fixture has both senders and silent inboxes");
  assert.ok(h.reads.some((r) => r.returned === 50), "and histories long enough to fill a page");
});

test("a row with no inbox on it is ignored", async () => {
  const found = await sendersWithSends([1, 2], async () => [null, 1, null], { limit: 10 });
  assert.deepEqual(sorted(found), [1]);
});

test("a full page that names nobody asked about is an error, not a quiet No", async () => {
  // What a read that ignored its filter would look like. Stopping silently
  // would report every remaining inbox as unassigned.
  await assert.rejects(
    sendersWithSends([1, 2], async (_ids, limit) => Array(limit).fill(99), { limit: 5 }),
    /full page naming none of the inboxes/,
  );
  // The same, when the ids come back as something that is not the number asked for.
  await assert.rejects(
    sendersWithSends([1, 2], async (_ids, limit) => Array(limit).fill(null), { limit: 5 }),
    /full page naming none of the inboxes/,
  );
});

test("a failed read fails the walk rather than leaving a partial answer", async () => {
  await assert.rejects(
    sendersWithSends([1, 2], async () => {
      throw new Error("statement timeout");
    }),
    /statement timeout/,
  );
});

/* ------------------------------------------------------------- filters --- */

test("with nothing chosen, every inbox is shown", () => {
  assert.equal(filtersActive(NO_FILTERS), false);
  assert.deepEqual(ids(filterInboxes(ROWS, NO_FILTERS)), [1, 2, 3, 4, "eve@three.com"]);
  // Spaces alone are not a search.
  assert.equal(filtersActive(only({ search: "   " })), false);
  assert.equal(filterInboxes(ROWS, only({ search: "   " })).length, 5);
});

test("search reads the email and the name, whatever the case", () => {
  assert.deepEqual(ids(filterInboxes(ROWS, only({ search: "two.com" }))), [3, 4]);
  // "amy" is in one inbox's email and another's name.
  assert.deepEqual(ids(filterInboxes(ROWS, only({ search: " AMY " }))), [1, 4]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ search: "lane" }))), ["eve@three.com"]);
  // A row with no name is searched by its email alone and does not break.
  assert.deepEqual(ids(filterInboxes(ROWS, only({ search: "cara" }))), [3]);
  assert.deepEqual(filterInboxes(ROWS, only({ search: "nobody" })), []);
  // Tags and vendors are filters, not part of the search.
  assert.deepEqual(filterInboxes(ROWS, only({ search: "zapmail" })), []);
});

test("type and status take one or several values", () => {
  assert.deepEqual(ids(filterInboxes(ROWS, only({ type: ["Custom SMTP"] }))), [3, 4]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ status: ["Connected"] }))), [1, 3]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ status: ["Not connected", "Failed"] }))), [2, 4]);
});

test("tags match an inbox carrying ANY of the chosen tags, whole names only", () => {
  assert.deepEqual(ids(filterInboxes(ROWS, only({ tags: ["Nicole Pool"] }))), [1, 3, "eve@three.com"]);
  // "Nicole Pool" and "Nicole Pool 2" are different pools.
  assert.deepEqual(ids(filterInboxes(ROWS, only({ tags: ["Nicole Pool 2"] }))), [2]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ tags: ["Nicole Pool 2", "Custom Mail Server"] }))), [2, 3]);
});

test("an inbox with no tags, no vendor or no status can be asked for by that", () => {
  assert.deepEqual(ids(filterInboxes(ROWS, only({ tags: [NONE] }))), [4]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ vendor: [NONE] }))), [4, "eve@three.com"]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ status: [NONE] }))), ["eve@three.com"]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ vendor: ["Maildoso", NONE] }))), [3, 4, "eve@three.com"]);
});

test("assigned Yes and No leave out the inboxes where it is not known", () => {
  assert.deepEqual(ids(filterInboxes(ROWS, only({ assigned: ["yes"] }))), [1, 3]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ assigned: ["no"] }))), [2, 4]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ assigned: [NONE] }))), ["eve@three.com"]);
});

test("platform narrows to one platform", () => {
  assert.deepEqual(ids(filterInboxes(ROWS, only({ platform: ["instantly"] }))), ["eve@three.com"]);
  assert.deepEqual(ids(filterInboxes(ROWS, only({ platform: ["emailbison"] }))), [1, 2, 3, 4]);
});

test("every filter has to hold at once", () => {
  const f = only({ search: "one.com", type: ["Google"], status: ["Connected", "Not connected"], tags: ["Google"], vendor: ["Zapmail"], assigned: ["no"] });
  assert.equal(filtersActive(f), true);
  assert.deepEqual(ids(filterInboxes(ROWS, f)), [2]);
  // One filter that nothing satisfies empties the table.
  assert.deepEqual(filterInboxes(ROWS, { ...f, platform: ["instantly"] }), []);
});

test("filtering does not change the list it was given", () => {
  const before = JSON.stringify(ROWS);
  filterInboxes(ROWS, only({ search: "amy", tags: ["Nicole Pool"] }));
  facetOptions(ROWS, only({ tags: ["Nicole Pool"] }), "vendor");
  assert.equal(JSON.stringify(ROWS), before);
});

test("every inbox answers to at least one value in every filter", () => {
  for (const row of ROWS) {
    for (const facet of INBOX_FACETS) assert.ok(facetValues(row, facet).length > 0, `${row.email} / ${facet}`);
  }
});

/* -------------------------------------------------------------- options --- */

const pairs = (rows: InboxRow[], filters: InboxFilters, facet: Parameters<typeof facetOptions>[2]) =>
  facetOptions(rows, filters, facet).map((o) => [o.label, o.count]);

test("options list what the inboxes hold, largest first, with 'none' last", () => {
  assert.deepEqual(pairs(ROWS, NO_FILTERS, "type"), [["Google", 3], ["Custom SMTP", 2]]);
  assert.deepEqual(pairs(ROWS, NO_FILTERS, "status"), [["Connected", 2], ["Failed", 1], ["Not connected", 1], ["Unknown", 1]]);
  assert.deepEqual(pairs(ROWS, NO_FILTERS, "vendor"), [["Zapmail", 2], ["Maildoso", 1], ["Untagged", 2]]);
  // An inbox counts once under each tag it carries.
  assert.deepEqual(pairs(ROWS, NO_FILTERS, "tags"), [
    ["Nicole Pool", 3], ["Google", 2], ["Custom Mail Server", 1], ["Nicole Pool 2", 1], ["No tags", 1],
  ]);
});

test("Assigned and Platform keep their own order", () => {
  assert.deepEqual(pairs(ROWS, NO_FILTERS, "assigned"), [["Yes", 2], ["No", 2], ["Unknown", 1]]);
  assert.deepEqual(pairs(ROWS, NO_FILTERS, "platform"), [["EmailBison", 4], ["Instantly", 1]]);
  // Even when the smaller one would otherwise sort first.
  const mostlyNo = [inbox({ id: 1, assignedToCampaign: false }), inbox({ id: 2, assignedToCampaign: false }), inbox({ id: 3, assignedToCampaign: true })];
  assert.deepEqual(pairs(mostlyNo, NO_FILTERS, "assigned"), [["Yes", 1], ["No", 2]]);
});

test("an option counts what the OTHER filters leave, so it matches the table", () => {
  const f = only({ vendor: ["Zapmail"] });
  // Two Zapmail inboxes: one connected, one not.
  assert.deepEqual(pairs(ROWS, f, "status"), [["Connected", 1], ["Not connected", 1]]);
  // The search narrows the options too.
  assert.deepEqual(pairs(ROWS, only({ search: "two.com" }), "type"), [["Custom SMTP", 2]]);
});

test("a filter's own ticks do not shrink its own options", () => {
  const f = only({ vendor: ["Zapmail"] });
  // Maildoso is still on offer — ticking it would ADD rows.
  assert.deepEqual(pairs(ROWS, f, "vendor"), [["Zapmail", 2], ["Maildoso", 1], ["Untagged", 2]]);
});

test("a ticked option that no longer matches anything stays listed, at 0", () => {
  const f = only({ vendor: ["Maildoso"], status: ["Failed"] });
  // No Maildoso inbox has failed, but Failed must remain there to untick.
  assert.deepEqual(pairs(ROWS, f, "status"), [["Connected", 1], ["Failed", 0]]);
});

test("the page before any inbox has loaded offers nothing", () => {
  assert.deepEqual(facetOptions([], NO_FILTERS, "tags"), []);
});

test("values are named for people", () => {
  assert.equal(facetValueLabel("tags", NONE), "No tags");
  assert.equal(facetValueLabel("vendor", NONE), "Untagged");
  assert.equal(facetValueLabel("status", NONE), "Unknown");
  assert.equal(facetValueLabel("assigned", "yes"), "Yes");
  assert.equal(facetValueLabel("assigned", "no"), "No");
  assert.equal(facetValueLabel("platform", "emailbison"), "EmailBison");
  assert.equal(facetValueLabel("tags", "Nicole Pool"), "Nicole Pool");
});

test("a tick is added, then removed, without touching the list it came from", () => {
  const start = ["a"];
  assert.deepEqual(toggleValue(start, "b"), ["a", "b"]);
  assert.deepEqual(toggleValue(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleValue([], "a"), ["a"]);
  assert.deepEqual(start, ["a"]);
});

test("the chip says what is chosen", () => {
  assert.equal(facetChipLabel("type", []), "Type");
  assert.equal(facetChipLabel("type", ["Google"]), "Type: Google");
  assert.equal(facetChipLabel("tags", ["Nicole Pool", "Google"]), "Tags: 2");
  assert.equal(facetChipLabel("assigned", ["no"]), "Assigned to campaign: No");
  assert.equal(facetChipLabel("vendor", [NONE]), "Vendor: Untagged");
  assert.equal(facetChipLabel("platform", ["instantly"]), "Platform: Instantly");
});

/* -------------------------------------------------------------- columns --- */

test("every column the client asked for is there, once", () => {
  const keys = INBOX_COLUMNS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, "no key is used twice");
  // The nine the client listed (13 Oct), shown by default and in their order.
  const ASKED = ["dailyLimit", "sent", "replied", "bounced", "warmup3d", "warmup7d", "status", "vendor", "assigned"];
  for (const key of ASKED) {
    assert.ok(keys.includes(key), `${key} is a column`);
    assert.ok(INBOX_DEFAULT_VISIBLE.includes(key), `${key} is shown by default`);
  }
  assert.deepEqual(INBOX_DEFAULT_VISIBLE.filter((k) => ASKED.includes(k)), ASKED, "in the order they were asked for");
  // Tags and Type were not asked for: there to switch on, off by default.
  for (const key of ["tags", "type"]) {
    assert.ok(keys.includes(key), `${key} is a column`);
    assert.ok(!INBOX_DEFAULT_VISIBLE.includes(key), `${key} is off by default`);
  }
});

test("every column sorts, and so does Email", () => {
  // A row with nothing unknown: each column must give something to sort by.
  const full = inbox({ name: "Amy", warmup3d: 91, warmup7d: 88, tags: ["Nicole Pool", "Google"] });
  for (const key of ["email", ...INBOX_COLUMNS.map((c) => c.key)]) {
    assert.notEqual(inboxSortValue(full, key), null, `${key} has a sort value`);
  }
  assert.equal(inboxSortValue(full, "not-a-column"), null);
});

test("numbers sort as numbers and text without regard to case", () => {
  assert.equal(inboxSortValue(inbox({ sentAllTime: 1200 }), "sent"), 1200);
  assert.equal(inboxSortValue(inbox({ repliedAllTime: 0 }), "replied"), 0);
  assert.equal(inboxSortValue(inbox({ dailyLimit: 15 }), "dailyLimit"), 15);
  assert.equal(inboxSortValue(inbox({ email: "Zed@One.com" }), "email"), "zed@one.com");
  assert.equal(inboxSortValue(inbox({ tags: ["Nicole Pool", "Google"] }), "tags"), "nicole pool, google");
  assert.equal(inboxSortValue(inbox({ platform: "instantly" }), "platform"), "Instantly");
});

test("what is not known has no sort value, so it sorts last either way", () => {
  const blank = inbox({
    type: null, status: null, dailyLimit: null, sentAllTime: null, repliedAllTime: null, bouncedAllTime: null,
    warmupEnabled: null, vendor: null, tags: [], assignedToCampaign: null,
  });
  for (const key of ["tags", "type", "status", "dailyLimit", "sent", "replied", "bounced", "warmup", "warmup3d", "warmup7d", "vendor", "assigned"]) {
    assert.equal(inboxSortValue(blank, key), null, key);
  }
});

test("Yes sorts apart from No, and On from Off", () => {
  assert.equal(inboxSortValue(inbox({ assignedToCampaign: true }), "assigned"), 1);
  assert.equal(inboxSortValue(inbox({ assignedToCampaign: false }), "assigned"), 0);
  assert.equal(inboxSortValue(inbox({ warmupEnabled: true }), "warmup"), 1);
  assert.equal(inboxSortValue(inbox({ warmupEnabled: false }), "warmup"), 0);
});

test("a connected inbox is green, a failed one red, anything else amber", () => {
  assert.equal(statusTone("Connected"), "s-done");
  assert.equal(statusTone("Failed"), "s-risk");
  assert.equal(statusTone("Not connected"), "s-pending");
  assert.equal(statusTone("pending_move"), "s-pending");
  assert.equal(statusTone(" connected "), "s-done");
});
