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
  "Hey {{lead.first_name}},\n\n" +
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
  // `{{lead.name}}` is deliberately absent: the greeting opens with the first
  // name, on the client's instruction, because the full name produced
  // "Hey Gisele Abrantes Trautman,".
  assert.equal(out.includes("{{lead.name}}"), false, "the greeting must not use the full name");
  for (const token of ["{{lead.first_name}}", "{{lead.phone_number}}", "{{lead.company}}", "{{sender.name}}"]) {
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

test("a custom intro replaces the standard wording, and is enough on its own", async () => {
  const m = await import("./intro-macro.ts");
  const base = { name: "OpsLabs", brokerage: "OpsLabs", contactName: null, contactRole: null, contactEmail: null };
  assert.equal(m.introReady(base), false);
  const custom = { ...base, introOverride: "  Hi {{lead.first_name}}, meet the OpsLabs team.  " };
  assert.equal(m.introReady(custom), true);
  assert.equal(m.introText(custom), "Hi {{lead.first_name}}, meet the OpsLabs team.");
  const blank = { ...base, contactName: "Chris Silvia", contactRole: "Director", introOverride: "   " };
  assert.equal(m.customIntro(blank), null);
  assert.equal(m.introText(blank), m.renderIntroMacroTemplate(blank));
});

test("more than three people: all named on one line and all copied in; people 4+ come from more_contacts", async () => {
  const m = await import("./intro-macro.ts");
  const more = m.moreContactsFrom([
    { name: "Dana Fourth", role: "Recruiter", email: "dana@x.com" },
    { name: "Eli Fifth", role: "Broker", email: "" },
    "junk", null, { name: "  ", role: " " },
  ]);
  assert.deepEqual(more.map((p) => p.name), ["Dana Fourth", "Eli Fifth"], "malformed and empty entries dropped");
  const client = {
    name: "Oz Group", brokerage: "Oz Group", contactName: "Ann First", contactRole: "Owner", contactEmail: "ann@x.com",
    extraContacts: [{ name: "Bob Second", role: "Team Leader", email: "bob@x.com" }, { name: "Cy Third", role: "Managing Broker", email: null }, ...more],
  };
  const text = m.renderIntroMacroTemplate(client);
  assert.match(text, /Ann First, Owner, Bob Second, Team Leader, Cy Third, Managing Broker, Dana Fourth, Recruiter, and Eli Fifth, Broker at Oz Group/);
  assert.deepEqual(m.introContactEmails(client), ["ann@x.com", "bob@x.com", "dana@x.com"]);
  assert.equal(m.moreContactsFrom(Array.from({ length: 12 }, (_, i) => ({ name: `P${i}`, role: "R" }))).length, m.MAX_INTRO_CONTACTS - 3, "capped at 10 people in all");
});

/* ---------------------------------------------------------------- territories (6 Oct) --- */
import { routeIntro, campaignCovers, slotTerritories, territoriesFrom, introContactEmails, moreContactsFrom } from "./intro-macro.ts";

const jeff = {
  name: "Jeff Cook Real Estate",
  brokerage: "Jeff Cook Real Estate",
  contactName: "Alma Nowatzke", contactRole: "Talent Specialist", contactEmail: "alma@jc.test",
  contactTerritories: ["Myrtle Beach", "Greenville"],
  extraContacts: [
    { name: "Angela Oakes", role: "Growth Advisor", email: "angela@jc.test", territories: ["Charlotte"] },
    { name: "Lance Overstreet", role: "Management Team", email: "lance@jc.test", territories: ["Charleston", "Summerville"] },
    { name: "Stan Taylor", role: "Management Team", email: "stan@jc.test", territories: ["Charleston", "Summerville"] },
    { name: "Stewart Samples", role: "Management Team", email: "stewart@jc.test", territories: ["Columbia"] },
  ],
};

test("territories: each of Jeff Cook's real campaign names reaches its own people only", () => {
  const cases: Array<[string, string[]]> = [
    ["Jeff Cook Real Estate + Charlotte–Triad, NC + ZF NS1 (EST)", ["Angela Oakes"]],
    ["Jeff Cook Real Estate + Charleston, SC + ZF NS1 (EST)", ["Lance Overstreet", "Stan Taylor"]],
    ["Jeff Cook Real Estate + Charleston–Summerville + ZF NS1 SEPT-2026 (EST)", ["Lance Overstreet", "Stan Taylor"]],
    ["Jeff Cook Real Estate LPT Realty 3 + Nicole + Moncks Corner, Summerville, Ladson, Goose Creek, Ridgeville, Hanahan", ["Lance Overstreet", "Stan Taylor"]],
    ["Jeff Cook Real Estate + Myrtle Beach + ZF NS1 SEPT-2026 (EST)", ["Alma Nowatzke"]],
    ["Jeff Cook Real Estate + Greenville + ZF NS1 SEPT-2026 (EST)", ["Alma Nowatzke"]],
    ["Jeff Cook (Personal Emails) - Columbia MLS", ["Stewart Samples"]],
  ];
  for (const [campaign, want] of cases) {
    const { client, route } = routeIntro(jeff, campaign);
    assert.deepEqual(route.people, want, campaign);
    assert.equal(route.fallback, false, campaign);
    assert.deepEqual(introContactEmails(client), want.map((n) => `${n.split(" ")[0].toLowerCase()}@jc.test`), campaign);
  }
});

test("territories: the intro names the territory's people in one sentence, like any multi-person intro", () => {
  const { client } = routeIntro(jeff, "Jeff Cook Real Estate + Charleston, SC + ZF NS1 (EST)");
  const text = renderIntroMacroTemplate(client);
  assert.match(text, /introduce you to Lance Overstreet, Management Team, and Stan Taylor, Management Team at Jeff Cook Real Estate/);
  assert.match(text, /Lance and Stan, I recently connected/);
  assert.doesNotMatch(text, /Alma|Angela|Stewart/);
});

test("territories: a campaign naming no territory introduces everyone, and says so", () => {
  const { client, route } = routeIntro(jeff, "Interested ZF - With Phone Number");
  assert.equal(route.fallback, true);
  assert.equal(introContactEmails(client).length, 5);
  assert.equal(routeIntro(jeff, null).route.fallback, true);
});

test("territories: someone with no territory is on every introduction", () => {
  const withOwner = { ...jeff, extraContacts: [...jeff.extraContacts, { name: "Jeff Cook", role: "Owner", email: "jeff@jc.test", territories: [] }] };
  assert.deepEqual(routeIntro(withOwner, "Jeff Cook Real Estate + Columbia + ZF").route.people, ["Stewart Samples", "Jeff Cook"]);
});

test("territories: a client with none set is exactly as before", () => {
  const plain = { name: "Oz Group", brokerage: "Oz Group", contactName: "A B", contactRole: "Owner", contactEmail: "a@oz.test" };
  const { client, route } = routeIntro(plain, "Oz Group + Charleston");
  assert.equal(client, plain);
  assert.equal(route.byTerritory, false);
});

test("territories: whole words only, any case, accents and dashes ignored", () => {
  assert.equal(campaignCovers("X + Charlotte–Triad, NC", "charlotte"), true);
  assert.equal(campaignCovers("X + North Charleston", "Charleston"), true);
  assert.equal(campaignCovers("X + Charlestonian", "Charleston"), false);
  assert.equal(campaignCovers("X + Charleston", "Charlotte"), false);
  assert.equal(campaignCovers("X + Mt. Pleasant", "Mt Pleasant"), true);
  assert.equal(campaignCovers("X + Myrtle Beach", ""), false);
});

test("territories: stored values are cleaned, and people 1-3 read by slot", () => {
  assert.deepEqual(territoriesFrom([" Charleston ", "", "charleston", 4, "Summerville"]), ["Charleston", "Summerville"]);
  assert.deepEqual(territoriesFrom("Charleston"), []);
  assert.deepEqual(slotTerritories({ "1": ["Greenville"], "3": ["Columbia"] }, 3), ["Columbia"]);
  assert.deepEqual(slotTerritories({ "1": ["Greenville"] }, 2), []);
  assert.deepEqual(slotTerritories(null, 1), []);
  assert.deepEqual(moreContactsFrom([{ name: "A", role: "R", email: null, territories: ["Columbia"] }])[0].territories, ["Columbia"]);
});

test("territories: a stored row maps to the same client the button and the agent use", async () => {
  const { introClientFromRow } = await import("./intro-macro.ts");
  const c = introClientFromRow({
    name: "Jeff Cook Real Estate", contact_name: "Alma Nowatzke", contact_role: "Talent Specialist", contact_email: "alma@jc.test",
    contact2_name: "Angela Oakes", contact2_role: "Growth Advisor", contact2_email: "angela@jc.test",
    contact3_name: null, contact3_role: null, contact3_email: null, brokerage: "Jeff Cook Real Estate", intro_override: "",
    more_contacts: [{ name: "Stewart Samples", role: "Management Team", email: "stewart@jc.test", territories: ["Columbia"] }],
    contact_territories: { "1": ["Myrtle Beach", "Greenville"], "2": ["Charlotte"] },
  }, "x");
  assert.equal(c.introOverride, null);
  assert.deepEqual(routeIntro(c, "JC + Greenville + ZF").route.people, ["Alma Nowatzke"]);
  assert.deepEqual(routeIntro(c, "JC + Columbia MLS").route.people, ["Stewart Samples"]);
  // Before 0029 (no contact_territories column): everyone, as today.
  const old = introClientFromRow({ name: "Jeff Cook Real Estate", contact_name: "Alma Nowatzke", contact_role: "Talent Specialist" }, "x");
  assert.equal(routeIntro(old, "JC + Greenville").route.byTerritory, false);
});
