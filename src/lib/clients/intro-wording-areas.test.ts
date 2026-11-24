import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  introClientFromRow,
  introVariantsFrom,
  ownAreaPlaces,
  peopleAreas,
  routeIntro,
  withoutOwnAreas,
  type IntroMacroClient,
  type IntroVariant,
} from "../tools/master-inbox/inbox/intro-macro.ts";

/*
 * 25 Nov 2026: a wording for a person follows that person's areas, so the areas are never typed on the wording too
 * (intro-macro.ts, "A WORDING FOR A PERSON FOLLOWS THEIR AREAS"). Douglas Elliman NYC had Lara's and Elisa's areas
 * typed on both; the team asked why everything is entered twice.
 */

// Douglas Elliman New York as it was on 24 Nov: areas on the people AND the same places typed on the wordings.
const DENY_ROW = {
  name: "Douglas Elliman New York", brokerage: "Douglas Elliman NYC", intro_override: "USUAL",
  contact_name: "Lara Chopoorian", contact_role: "Director of Agent Expansion", contact_email: "lara@example.com",
  contact2_name: "Elisa Angelone", contact2_role: "Director of Agent Expansion", contact2_email: "elisa@example.com",
  contact_territories: { "1": ["REBNY", "Manhattan", "Brooklyn"], "2": ["OneKey", "Long Island"] },
  intro_variants: [
    { id: "a", label: "Lara Chopoorian", places: ["Manhattan", "Brooklyn", "REBNY"], people: ["Lara Chopoorian"], text: "LARA" },
    { id: "b", label: "Elisa Angelone", places: ["Long Island", "ONEKEY"], people: ["Elisa Angelone"], text: "ELISA" },
  ],
};
// Every campaign name the client had on 24 Nov (the Assistant's live listing), plus what-ifs.
const DENY_CAMPAIGNS = [
  "Douglas Elliman New York + New York REBNY (EST)", "Douglas Elliman New York + New York OneKey (EST)",
  "Douglas Elliman New York 4 + New York (EST)", "Douglas Elliman NYC + Nicole +REBNY", "Douglas Elliman NYC 2 + Nicole +REBNY",
  "Douglas Elliman NYC + Nicole + REBNY", "Douglas Elliman NYC 4 (Personal Emails) - Elisa", "Douglas Elliman NYC 6 - Lara",
  "Douglas Elliman (Pro) - Brooklyn Lara", "Douglas Elliman (Client Perso) -  Christie's Elisa", "Douglas Elliman 2 (Pro) - Lara (copy)",
  "Douglas Elliman New York 1 + New York REBNY (EST)", "Douglas Elliman NYC 1 + Nicole +REBNY",
  "Douglas Elliman REBNY + Long Island", "Douglas Elliman Queens", "Douglas Elliman Manhattan", "Douglas Elliman ONEKEY", null,
];
const sent = (c: IntroMacroClient, campaign: string | null) => {
  const r = routeIntro(c, campaign);
  return { people: r.route.people, text: r.client.introOverride ?? null };
};

test("Douglas Elliman NYC: the wordings' own areas are found, and only those", () => {
  const c = introClientFromRow(DENY_ROW, DENY_ROW.name);
  const areas = peopleAreas(c);
  assert.deepEqual(areas, [
    { name: "Lara Chopoorian", areas: ["REBNY", "Manhattan", "Brooklyn"] },
    { name: "Elisa Angelone", areas: ["OneKey", "Long Island"] },
  ]);
  const [lara, elisa] = c.introVariants ?? [];
  assert.deepEqual(ownAreaPlaces(lara, areas), ["Manhattan", "Brooklyn", "REBNY"]);
  assert.deepEqual(ownAreaPlaces(elisa, areas), ["Long Island", "ONEKEY"], "any case");
  assert.deepEqual(withoutOwnAreas(c.introVariants ?? [], areas).map((v) => v.places), [[], []]);
  // A place that is ANOTHER person's area is a real market choice, not a repeat: kept.
  assert.deepEqual(ownAreaPlaces({ places: ["Long Island", "Queens"], people: ["Lara Chopoorian"] }, areas), []);
  // A wording for nobody (markets only) has no own areas.
  assert.deepEqual(ownAreaPlaces({ places: ["Brooklyn"], people: [] }, areas), []);
});

test("Douglas Elliman NYC: with the areas typed once, every campaign sends exactly what it sent before", () => {
  const before = introClientFromRow(DENY_ROW, DENY_ROW.name);
  const after = { ...before, introVariants: withoutOwnAreas(before.introVariants ?? [], peopleAreas(before)) };
  for (const n of DENY_CAMPAIGNS) assert.deepEqual(sent(after, n), sent(before, n), String(n));
  assert.deepEqual(sent(after, "Douglas Elliman New York + New York REBNY (EST)"), { people: ["Lara Chopoorian"], text: "LARA" });
  assert.deepEqual(sent(after, "Douglas Elliman New York + New York OneKey (EST)"), { people: ["Elisa Angelone"], text: "ELISA" });
  assert.deepEqual(sent(after, "Douglas Elliman NYC 6 - Lara"), { people: ["Lara Chopoorian", "Elisa Angelone"], text: "USUAL" });
});

test("why: move Brooklyn to Elisa, and only the areas-typed-once wording follows her", () => {
  const moved = { ...DENY_ROW, contact_territories: { "1": ["REBNY", "Manhattan"], "2": ["OneKey", "Long Island", "Brooklyn"] } };
  const twice = introClientFromRow(moved, moved.name);
  const once = { ...twice, introVariants: withoutOwnAreas(introVariantsFrom(DENY_ROW.intro_variants), peopleAreas(introClientFromRow(DENY_ROW, DENY_ROW.name))) };
  const brooklyn = "Douglas Elliman (Pro) - Brooklyn Lara";
  assert.deepEqual(sent(twice, brooklyn), { people: ["Elisa Angelone"], text: "LARA" }, "the old way: Elisa gets the intro that names Lara");
  assert.deepEqual(sent(once, brooklyn), { people: ["Elisa Angelone"], text: "ELISA" });
});

test("a name on two rows is one person with both rows' areas; someone without a role is not introduced, so not counted", () => {
  const c: IntroMacroClient = {
    name: "Jeff Cook", brokerage: "Jeff Cook Real Estate", contactName: "Alma Nowatzke", contactRole: "Talent Specialist", contactTerritories: ["Greenville"],
    extraContacts: [
      { name: "Alma Nowatzke", role: "Talent Specialist", territories: ["Myrtle Beach"] },
      { name: "Stewart Samples", role: "Management Team", territories: ["Columbia"] },
      { name: "No Role", role: null, territories: ["Queens"] },
    ],
  };
  const areas = peopleAreas(c);
  assert.deepEqual(areas, [
    { name: "Alma Nowatzke", areas: ["Greenville", "Myrtle Beach"] },
    { name: "Stewart Samples", areas: ["Columbia"] },
  ]);
  assert.deepEqual(ownAreaPlaces({ places: ["Myrtle Beach", "Queens"], people: ["Alma Nowatzke", "No Role"] }, areas), ["Myrtle Beach"]);
});

test("never changes who gets which wording: 400 random sets of wordings on three real clients' people", () => {
  const jeff: IntroMacroClient = {
    name: "Jeff Cook", brokerage: "Jeff Cook Real Estate", introOverride: "USUAL",
    contactName: "Alma Nowatzke", contactRole: "Talent Specialist", contactTerritories: ["Myrtle Beach", "Greenville"],
    extraContacts: [
      { name: "Angela Oakes", role: "Growth Advisor", territories: ["Charlotte"] },
      { name: "Lance Overstreet", role: "Management Team", territories: ["Charleston", "Summerville"] },
      { name: "Stan Taylor", role: "Management Team", territories: ["Charleston", "Summerville"] },
      { name: "Stewart Samples", role: "Management Team", territories: ["Columbia"] },
      { name: "Jeff Cook", role: "Owner", territories: [] },
      { name: "No Role", role: null, territories: ["Queens"] },
    ],
  };
  const pe: IntroMacroClient = {
    name: "Properties & Estates", brokerage: "Properties & Estates", introOverride: "USUAL",
    contactName: "Adam Treat", contactRole: "Broker", contactTerritories: ["Florida"],
    extraContacts: [{ name: "Mark Barter", role: "Broker", territories: ["Boston"] }],
  };
  const clients = [introClientFromRow(DENY_ROW, DENY_ROW.name), jeff, pe];
  const vocab = ["REBNY", "Manhattan", "Brooklyn", "OneKey", "Long Island", "Myrtle Beach", "Greenville", "Charlotte", "Charleston",
    "Summerville", "Columbia", "Florida", "Boston", "Queens", "New York"];
  const names: Array<string | null> = [null, "Interested ZF", ...vocab.map((v) => `X + ${v} + ZF`)];
  for (const a of vocab) for (const b of vocab) if (a < b) names.push(`X + ${a} + ${b}`);
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 400; run++) {
    const client = clients[run % clients.length];
    const pool = [...peopleAreas(client).map((p) => p.name), "No Role"];
    const raw = Array.from({ length: 1 + rnd(4) }, (_, i) => ({
      id: `v${i}`, text: `W${i}`,
      places: Array.from({ length: rnd(4) }, () => vocab[rnd(vocab.length)]),
      people: Array.from({ length: rnd(3) }, () => pool[rnd(pool.length)]),
    }));
    const variants: IntroVariant[] = introVariantsFrom(raw);
    const before = { ...client, introVariants: variants };
    const after = { ...client, introVariants: withoutOwnAreas(variants, peopleAreas(client)) };
    for (const n of names) assert.deepEqual(sent(after, n), sent(before, n), `run ${run}, ${client.name}, ${n}, ${JSON.stringify(variants)}`);
  }
});

/* ---- the save: through the real save and read, against an in-memory os_clients row ---- */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const row: Record<string, unknown> = {
  id: "c1", ...DENY_ROW, contact3_name: null, contact3_role: null, contact3_email: null,
  intro_subject: null, more_contacts: [],
};
const writes: Record<string, unknown>[] = [];
function osTable() {
  const b = {
    select: () => b, eq: () => b, not: () => b, limit: () => b, order: () => b, in: () => b, is: () => b,
    maybeSingle: async () => ({ data: row, error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
    update: (patch: Record<string, unknown>) => ({ eq: async () => { writes.push(patch); Object.assign(row, patch); return { error: null }; } }),
  };
  return b;
}
let saveIntroVariants: typeof import("./intro-override").saveIntroVariants;
let introView: typeof import("./intro-override").introView;

test("setup", { skip }, async () => {
  mock.module("./os-db", { namedExports: { osTable } });
  mock.module("./intro-template-sync", { namedExports: { syncIntroTemplate: async () => "unchanged" } });
  mock.module("../supabase/admin", { namedExports: { createAdminSupabase: () => ({ from: osTable }) } });
  ({ saveIntroVariants, introView } = await import("./intro-override"));
});

test("the page is told each person's areas", { skip }, async () => {
  const v = await introView("c1");
  assert.deepEqual(v.peopleAreas, [
    { name: "Lara Chopoorian", areas: ["REBNY", "Manhattan", "Brooklyn"] },
    { name: "Elisa Angelone", areas: ["OneKey", "Long Island"] },
  ]);
});

test("saving leaves out a person's own areas, keeps every other market, text and order", { skip }, async () => {
  const v = await saveIntroVariants("c1", [
    { id: "a", label: "Lara Chopoorian", places: ["Manhattan", "Brooklyn", "REBNY", "Queens"], people: ["Lara Chopoorian"], text: "LARA" },
    { id: "b", label: "Elisa Angelone", places: ["Long Island", "ONEKEY"], people: ["Elisa Angelone"], text: "ELISA" },
    { id: "c", label: "Staten Island", places: ["Staten Island", "Brooklyn"], people: [], text: "SI" },
  ]);
  const stored = writes.at(-1)?.intro_variants as IntroVariant[];
  assert.deepEqual(stored.map((x) => [x.id, x.places, x.people, x.text]), [
    ["a", ["Queens"], ["Lara Chopoorian"], "LARA"],
    ["b", [], ["Elisa Angelone"], "ELISA"],
    ["c", ["Staten Island", "Brooklyn"], [], "SI"],
  ]);
  assert.deepEqual(v.variants.map((x) => x.places), [["Queens"], [], ["Staten Island", "Brooklyn"]]);
});

test("a client nobody has an area on saves its markets exactly as typed", { skip }, async () => {
  row.contact_territories = {};
  await saveIntroVariants("c1", [{ id: "a", places: ["Manhattan", "Brooklyn"], people: ["Lara Chopoorian"], text: "LARA" }]);
  assert.deepEqual((writes.at(-1)?.intro_variants as IntroVariant[])[0].places, ["Manhattan", "Brooklyn"]);
  assert.deepEqual((await introView("c1")).peopleAreas.map((p) => p.areas), [[], []]);
});
