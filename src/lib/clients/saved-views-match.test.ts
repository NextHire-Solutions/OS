import assert from "node:assert/strict";
import { test } from "node:test";

import { viewsByClient, words } from "./saved-views-match.ts";

const V = (id: string, name: string, orch: string[] = []) => ({ id, name, agents: 100, orchClientIds: orch });
const C = (id: string, name: string, aliases: string[] = [], orch: string | null = null) => ({ id, name, aliases, orchClientId: orch });

const views = [
  V("1", "ChuckTown - Charleston, SC"), V("2", "JPAR for Iron Horse"), V("3", "Jeff Cook - Greenville"),
  V("4", "Douglas Elliman LA"), V("5", "Douglas Elliman NYC"), V("6", "Douglas Elliman - Orange County"),
  V("7", "Rise Real Estate Antelope"), V("8", "Properties & Estates Boston"), V("9", "Norvell&Co"),
  V("10", "Oz Group"), V("11", "Momentum Realty - California"),
];
const clients = [
  C("ct", "ChuckTown Homes Team"), C("jp", "JPAR Iron Horse Real Estate"), C("jc", "Jeff Cook Real Estate"),
  C("dla", "Douglas Elliman Los Angeles", ["Douglas Elliman LA"]), C("dny", "Douglas Elliman NYC"), C("dlv", "Douglas Elliman Las Vegas"),
  C("rt", "Rise Real Estate Tujunga"), C("pe", "Properties & Estates", ["Properties & Estates Boston"]), C("nv", "Norvell&Co Real Estate"),
  C("oz", "Oz Group"), C("mo", "Momentum Realty"), C("ra", "Raintown Realty"),
];

test("names match on distinctive words, generic ones (Homes, Team, Real Estate) ignored", () => {
  const m = viewsByClient(clients, views, []);
  const names = (id: string) => m.get(id)!.map((v) => v.name);
  assert.deepEqual(names("ct"), ["ChuckTown - Charleston, SC"]);
  assert.deepEqual(names("jp"), ["JPAR for Iron Horse"]);
  assert.deepEqual(names("jc"), ["Jeff Cook - Greenville"]);
  assert.deepEqual(names("dla"), ["Douglas Elliman LA"], "through the alias");
  assert.deepEqual(names("dny"), ["Douglas Elliman NYC"]);
  assert.deepEqual(names("dlv"), [], "Orange County names no office");
  assert.deepEqual(names("rt"), [], "another Rise office's view is not Tujunga's");
  assert.deepEqual(names("pe"), ["Properties & Estates Boston"]);
  assert.deepEqual(names("nv"), ["Norvell&Co"]);
  assert.deepEqual(names("oz"), ["Oz Group"]);
  assert.deepEqual(names("mo"), ["Momentum Realty - California"]);
  assert.deepEqual(names("ra"), []);
});

test("a link adds a view and an exclusion removes a match; the Client filter counts too", () => {
  const m = viewsByClient([...clients, C("x", "Someone", [], "orch-1")], [...views, V("12", "Untitled", ["orch-1"])], [
    { clientId: "rt", viewId: "7", excluded: false },
    { clientId: "oz", viewId: "10", excluded: true },
  ]);
  assert.deepEqual(m.get("rt")!.map((v) => [v.name, v.source]), [["Rise Real Estate Antelope", "linked"]]);
  assert.equal(m.get("oz")!.length, 0);
  assert.deepEqual(m.get("x")!.map((v) => v.source), ["client filter"]);
});

test("words: punctuation splits, generic words go", () => {
  assert.deepEqual(words("The Wurst Team at A Better Way"), ["wurst", "better", "way"]);
  assert.deepEqual(words("RE/MAX Pacific"), ["re", "max", "pacific"]);
});
