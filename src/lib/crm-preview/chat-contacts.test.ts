/*
 * Who the assistant says receives interested agents (5 Nov). Run against the hand-off's own rules, not a copy: what it
 * says is who really gets the email, and a person the hand-off leaves out is left out here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { introClientFromRow, INTRO_ROW_COLUMNS } from "@/lib/tools/master-inbox/inbox/intro-macro";
import { planRecipients } from "@/lib/tools/master-inbox/relay/rules";
import { brokerageFromJson } from "@/lib/tools/master-inbox/relay/settings";

import { contactsOfPortal, interestedContacts, NOBODY_FOR_MARKET } from "./chat-contacts.ts";
import { runTool } from "./chat-tools.ts";

const RECORD = {
  name: "Acme Realty",
  contact_name: "Jo Bloggs", contact_role: "Broker", contact_email: "Jo@Acme.example",
  contact2_name: "Sam Reed", contact2_role: "Team Leader", contact2_email: "sam@acme.example",
  contact3_name: null, contact3_role: null, contact3_email: null,
  more_contacts: [{ name: "Lee Park", role: "Owner", email: "lee@acme.example" }],
  // What a person never needs told, and is on the same row.
  brokerage: "Acme Holdings", intro_override: "PRIVATE WORDING", intro_variants: [{ label: "x", text: "PRIVATE VARIANT" }], relay_settings: { enabled: true, mode: "automatic" }, pipeline_entry: "interested",
  mi_client_id: "portal-1", aliases: ["Acme Florida"],
};
const people = (row: Record<string, unknown> | null) => {
  const out = interestedContacts(row, "Acme Realty");
  assert.ok("people" in out);
  return out.people;
};

test("everyone on the record, first contact first, by name and email", () => {
  assert.deepEqual(people(RECORD), [
    { name: "Jo Bloggs", email: "jo@acme.example", markets: [] },
    { name: "Sam Reed", email: "sam@acme.example", markets: [] },
    { name: "Lee Park", email: "lee@acme.example", markets: [] },
  ]);
});

test("nothing else on the record comes along: only a name, an email and the markets", () => {
  const text = JSON.stringify(people(RECORD));
  for (const never of ["PRIVATE", "Broker", "Team Leader", "Owner", "Acme Holdings", "automatic"]) assert.ok(!text.includes(never), never);
  for (const p of people(RECORD)) assert.deepEqual(Object.keys(p).sort(), ["email", "markets", "name"]);
});

test("the people the hand-off itself would email: the same list, whatever the campaign", () => {
  const client = introClientFromRow(RECORD, "Acme Realty");
  for (const campaign of [null, "Acme Realty + Charleston, SC", "anything"]) {
    const sent = planRecipients(brokerageFromJson(RECORD.relay_settings), client, campaign, []).recipients;
    assert.deepEqual(people(RECORD).map((p) => [p.name, p.email]), sent.map((r) => [r.name, r.email]), String(campaign));
  }
});

test("markets: each person's own, the first three's and later ones' alike, and they cover the same agents the hand-off sends them", () => {
  const row = { ...RECORD, contact_territories: { "1": ["Charleston", "Summerville"] }, more_contacts: [{ name: "Lee Park", role: "Owner", email: "lee@acme.example", territories: ["Myrtle Beach"] }] };
  assert.deepEqual(people(row), [
    { name: "Jo Bloggs", email: "jo@acme.example", markets: ["Charleston", "Summerville"] },
    { name: "Sam Reed", email: "sam@acme.example", markets: [] },
    { name: "Lee Park", email: "lee@acme.example", markets: ["Myrtle Beach"] },
  ]);
  const client = introClientFromRow(row, "Acme Realty");
  const sent = planRecipients(brokerageFromJson(row.relay_settings), client, "Acme Realty + Charleston, SC", []).recipients.map((r) => r.email);
  assert.deepEqual(sent, ["jo@acme.example", "sam@acme.example"], "Jo's market and Sam, who covers everything: not Lee");
});

test("left out as the hand-off leaves them out: no email or a bad one, half a person, the same address twice", () => {
  const row = { ...RECORD, contact2_email: null, contact3_name: "No Role", contact3_role: null, contact3_email: "norole@acme.example", more_contacts: [{ name: "Bad Mail", role: "Owner", email: "not-an-email" }, { name: "Jo Again", role: "Owner", email: " JO@acme.example " }] };
  assert.deepEqual(people(row), [{ name: "Jo Bloggs", email: "jo@acme.example", markets: [] }]);
});

test("a brokerage's own address is the answer only while the hand-off replaces the introduction", () => {
  const address = { recipients: "address", address: "Leads@Acme.example" };
  const own = interestedContacts({ ...RECORD, relay_settings: { enabled: true, ...address } }, "Acme Realty");
  assert.deepEqual(own, { people: [{ name: null, email: "leads@acme.example", markets: [] }] });
  const contacts = ["jo@acme.example", "sam@acme.example", "lee@acme.example"];
  assert.deepEqual(people({ ...RECORD, relay_settings: { enabled: false, ...address } }).map((p) => p.email), contacts);
  assert.deepEqual(people({ ...RECORD, pipeline_entry: "introduction", relay_settings: { enabled: true, ...address } }).map((p) => p.email), contacts, "the Introduce button still copies the contacts in");
  // Same address as a contact with markets: on the hand-off it receives everything.
  const same = interestedContacts({ ...RECORD, contact_territories: { "1": ["Charleston"] }, relay_settings: { enabled: true, recipients: "address", address: "jo@acme.example" } }, "Acme Realty");
  assert.deepEqual(same, { people: [{ name: null, email: "jo@acme.example", markets: [] }] });
});

test("no record, or a record with nobody on it, is nobody: never someone else", () => {
  assert.deepEqual(people(null), []);
  assert.deepEqual(people({ name: "Acme Realty" }), []);
});

test("it asks for this portal's record only, for the columns the hand-off reads, and a failed read is never a guess", async () => {
  const asked: unknown[][] = [];
  const out = await contactsOfPortal(async (...a) => { asked.push(a); return { row: RECORD }; }, "portal-1", "Acme Realty");
  assert.deepEqual(asked, [["portal-1", "Acme Realty", `${INTRO_ROW_COLUMNS}, relay_settings, pipeline_entry, mi_client_id, aliases`]]);
  assert.ok("people" in out && out.people.length === 3);
  assert.deepEqual(await contactsOfPortal(async () => ({ row: null, readFailed: true }), "p", "Acme"), { unavailable: "The contacts could not be read just now." }, "a route or name read that failed isn't nobody on file");

  const failed = { unavailable: "The contacts could not be read just now." };
  assert.deepEqual(await contactsOfPortal(async () => ({ row: null, error: "boom" }), "p", "Acme"), failed);
  assert.deepEqual(await contactsOfPortal(async () => { throw new Error("boom"); }, "p", "Acme"), failed);
  assert.deepEqual(await contactsOfPortal(async () => ({ row: null }), "p", "Acme"), { people: [] });
});

test("the assistant's data is loaded for the portal the request names, after the gate, and the relay's rules stay out of the browser", () => {
  const chat = readFileSync("src/lib/crm-preview/chat.ts", "utf8");
  assert.match(chat, /contactsOfPortal\(rosterRowForPortal, c\.id, c\.name\)/);
  const tools = readFileSync("src/lib/crm-preview/chat-tools.ts", "utf8");
  assert.doesNotMatch(tools, /from "[^"]*(chat-contacts|relay\/rules|roster-for-portal)/);
  const route = readFileSync("src/app/api/crm-preview/chat/route.ts", "utf8");
  assert.ok(route.indexOf("mayOpenPortal(viewer, client)") < route.indexOf("loadPortalChatData(client)"), "a client opens only their own portal before anything loads");
  assert.ok(route.indexOf("closedToClient(viewer") < route.indexOf("loadPortalChatData(client)"));
});

/* What a person is told, against what the hand-off does, for each way the two came apart in review (5 Nov). */
const OTHER = "any other market, or a campaign that names none";
const JO = { contact_name: "Jo", contact_role: "Broker", contact_email: "jo@acme.example" };
const SAM = { contact2_name: "Sam", contact2_role: "Owner", contact2_email: "sam@acme.example" };
const NONE = { contact3_name: null, contact3_role: null, contact3_email: null, more_contacts: [] };
const tableOf = (row: Record<string, unknown>) => {
  const out = interestedContacts(row, "Acme Realty");
  assert.ok("people" in out);
  return out.whoGetsWhichMarket as Record<string, string[]>;
};
const sentTo = (row: Record<string, unknown>, campaign: string) =>
  planRecipients(brokerageFromJson(row.relay_settings), introClientFromRow(row, "Acme Realty"), campaign, []).recipients.map((r) => `${r.name} <${r.email}>`);
const base = { ...RECORD, ...JO, ...SAM, ...NONE };

test("every market in the table is exactly who the hand-off emails for a campaign in that market", () => {
  const row = { ...base, contact_territories: { "1": ["Charleston", "Summerville"], "2": ["Myrtle Beach"] }, more_contacts: [{ name: "Lee", role: "Owner", email: "lee@acme.example" }] };
  const table = tableOf(row);
  for (const place of ["Charleston", "Summerville", "Myrtle Beach"]) assert.deepEqual(table[place], sentTo(row, `Acme Realty + ${place}, SC`), place);
  assert.deepEqual(table[OTHER], sentTo(row, "Acme Realty + Atlanta, GA"));
  assert.deepEqual(table.Charleston, ["Jo <jo@acme.example>", "Lee <lee@acme.example>"]);
  assert.deepEqual(table[OTHER], ["Jo <jo@acme.example>", "Sam <sam@acme.example>", "Lee <lee@acme.example>"]);
});

test("a market inside another: North Charleston also goes to whoever covers Charleston", () => {
  const row = { ...base, contact_territories: { "1": ["Charleston"], "2": ["North Charleston"] } };
  const table = tableOf(row);
  assert.deepEqual(table["North Charleston"], ["Jo <jo@acme.example>", "Sam <sam@acme.example>"]);
  assert.deepEqual(table["North Charleston"], sentTo(row, "Acme Realty + North Charleston, SC"));
  assert.deepEqual(table.Charleston, ["Jo <jo@acme.example>"]);
  assert.deepEqual(table.Charleston, sentTo(row, "Acme Realty + Charleston, SC"));
});

test("case and punctuation don't split a market into two", () => {
  for (const [a, b] of [["Charleston", "charleston"], ["Mt. Pleasant", "Mt Pleasant"]]) {
    const table = tableOf({ ...base, contact_territories: { "1": [a], "2": [b] } });
    assert.deepEqual(Object.keys(table), [a, OTHER], a);
    assert.deepEqual(table[a], ["Jo <jo@acme.example>", "Sam <sam@acme.example>"], a);
  }
});

test("a market whose only person has no email says so: it doesn't fall in with the others, and nobody is invented", () => {
  const row = { ...base, contact_email: null, contact_territories: { "1": ["Charleston"], "2": ["Columbia"] } };
  const table = tableOf(row);
  assert.deepEqual(sentTo(row, "Acme Realty + Charleston, SC"), [], "the hand-off holds this one");
  assert.deepEqual(table.Charleston, [NOBODY_FOR_MARKET]);
  assert.deepEqual(table.Columbia, ["Sam <sam@acme.example>"]);
});

test("one address on the record twice: its markets add up, and a row with no market means every agent", () => {
  const twice = { ...base, contact3_name: "Jo", contact3_role: "Broker", contact3_email: "JO@acme.example" };
  const both = { ...twice, contact_territories: { "1": ["Charleston"], "2": ["Greenville"], "3": ["Columbia"] } };
  assert.deepEqual(people(both).find((p) => p.email === "jo@acme.example")!.markets, ["Charleston", "Columbia"]);
  assert.deepEqual(tableOf(both).Columbia, sentTo(both, "Acme Realty + Columbia, SC"));
  const everything = { ...twice, contact_territories: { "1": ["Charleston"], "2": ["Greenville"] } };
  assert.deepEqual(people(everything).find((p) => p.email === "jo@acme.example")!.markets, []);
  assert.deepEqual(tableOf(everything).Greenville, sentTo(everything, "Acme Realty + Greenville, SC"));
  assert.deepEqual(tableOf(everything).Greenville, ["Sam <sam@acme.example>", "Jo <jo@acme.example>"], "in the record's order, as the hand-off lists them");
});

test("nobody with a market: no table at all", () => {
  const out = interestedContacts(RECORD, "Acme Realty");
  assert.ok("people" in out && out.whoGetsWhichMarket === undefined);
});

/* "make sure client can see only their data only": a campaign route that went stale must not show one client another's people. */
test("a record that isn't provably this portal's is refused and logged, never shown", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  const refused = { unavailable: "The contacts could not be read just now." };
  const someoneElse = { ...RECORD, name: "Other Realty", aliases: ["Other Florida"], mi_client_id: "other-portal" };
  assert.deepEqual(await contactsOfPortal(async () => ({ row: someoneElse }), "portal-1", "Acme Realty"), refused);
  assert.deepEqual(await contactsOfPortal(async () => ({ row: someoneElse }), "portal-1", null), refused);
  assert.deepEqual(await contactsOfPortal(async () => ({ row: { ...someoneElse, aliases: null, mi_client_id: null } }), "portal-1", ""), refused);
  assert.deepEqual(await contactsOfPortal(async () => ({ row: { ...someoneElse, name: null, aliases: null, mi_client_id: null } }), "portal-1", ""), refused, "no name on either side is not a match");
  assert.equal(logged.mock.callCount(), 4);
  assert.ok(!JSON.stringify(logged.mock.calls).includes("acme.example"), "the log names no one");

  for (const row of [
    { ...RECORD, mi_client_id: "portal-1", name: "Renamed", aliases: [] }, // linked
    { ...RECORD, mi_client_id: "main-portal", name: "Acme Realty", aliases: [] }, // its name
    { ...RECORD, mi_client_id: "main-portal", name: "Acme", aliases: ["ACME  Florida!"] }, // an alias, as the lookup compares them
  ]) {
    const out = await contactsOfPortal(async () => ({ row }), "portal-1", row.name === "Acme" ? "Acme Florida" : "Acme Realty");
    assert.ok("people" in out && out.people.length === 3, JSON.stringify(row.aliases));
  }
});

test("the assistant's tool hands on the table it was given, unchanged", async () => {
  const row = { ...base, contact_territories: { "1": ["Charleston"] } };
  const answer = await runTool("interested_contacts", "{}", { contacts: interestedContacts(row, "Acme Realty") } as never, async () => ({ unavailable: "none" }));
  assert.deepEqual(answer.who_gets_which_market, tableOf(row));
  assert.deepEqual(answer.contacts, [{ name: "Jo", email: "jo@acme.example", markets: ["Charleston"] }, { name: "Sam", email: "sam@acme.example" }]);
});

