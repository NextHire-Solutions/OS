/*
 * 24 Nov, the client:
 *   1. "Add a Select All option in both the My Agents section and the Setup Wizard to allow users to select all
 *      agents at once."
 *   2. "Add a DNC section to the Setup Wizard. Display the DNC list with the same selection and filtering functionality
 *      as the Markets list. Allow users to search, filter, and select specific DNC lists."
 * The screens are client components; these pin what each one sends (the moves themselves, and the server taking
 * every agent picked, are tested in portal-save.test.ts). Since 24 Nov (Sankalp: "Remove the cap. By select all it
 * should select all agents") there is no limit on My Agents or the DNC List — only the question first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const setup = read("../../components/crm-preview/setup.tsx");
const pages = read("../../components/crm-preview/pages.tsx");
const fn = (src: string, name: string) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const next = src.indexOf("\nfunction ", at + 10);
  return src.slice(at, next < 0 ? undefined : next);
};

test("Setup › Find your agents: Select all that match sends the filters to My Agents (Market's move) — every agent, no limit, asked first", () => {
  const s = fn(setup, "AgentsStep");
  assert.match(s, /Select all \{fmt\(total\)\} that match/);
  assert.match(s, /type: "market\.moveAll", list: "market", query: sp\.toString\(\), to: "My Agents"/);
  assert.doesNotMatch(s, /const cap =|narrow the filters/, "no limit on how many (Sankalp, 24 Nov)");
  assert.match(s, /if \(!allMarked && ids\.length > MAX_TICKED\)/, "only agents ticked one by one keep the save's limit on named agents — Select all sends the filters");
  assert.match(s, /We'll never email them in any campaign\. This can't be undone\./);
  assert.doesNotMatch(s, /to: "My Agents", setup: true/, "never sent as the setup's pick (that is Prospects only)");
  assert.match(s, /setAllMarked\(false\), \[tab, q, f\]/, "a new search, filter or tab clears \"all\"");
  assert.match(s, /Select all \{fmt\(mine\.length\)\}/, "the My Agents tab selects every agent its search shows, for Remove selected");
});

test("My Agents page: a one-click Select all on the bulk bar, every agent the search shows", () => {
  const s = fn(pages, "MyAgentsScreen");
  assert.match(s, /total=\{found\.length\}/);
  assert.match(s, /onSelectAll=\{\(\) => pick\(found\.map\(\(a\) => a\.id\), true\)\}/);
  const bulk = fn(pages, "Bulk");
  assert.match(bulk, /Select all \{total\.toLocaleString\("en-US"\)\} \{noun\}/);
  assert.match(bulk, /count < total/, "hidden once everything is selected");
});

test("Setup › Your DNC List: one list with Market's search, filters and Select all — its agents to take off, the market to add from, every entry", () => {
  const s = fn(setup, "DncStep");
  assert.match(s, /function DncStep\(\{ clientId, dnc \}/);
  assert.match(s, /useState<"list" \| "market" \| "entries">\("list"\)/, "opens on the DNC List itself");
  assert.match(s, /\{ id: "list", label: "Your DNC List"/);
  assert.match(s, /\{ id: "market", label: "Add from your market"/);
  assert.match(s, /\{ id: "entries", label: "Every entry"/);
  assert.doesNotMatch(s, /DNC List · Agents|DNC List · Companies/, "no longer split in two");
  // Your DNC List: the market kept to the DNC List, with every Market filter.
  assert.match(s, /useMarket\(clientId, "market", onMarket \? page : 1, onMarket \? qMarket : "", f, onMarket, version, tab === "list"\)/);
  assert.match(s, /<MarketFilters clientId=\{clientId\} list="market" value=\{f\} onChange=\{setF\} \/>/, "the same filters as Market");
  assert.match(s, /Select all \{fmt\(marketTotal\)\} that match/);
  // Remove: off the DNC List only (dncOnly), the filters plus onlist=dnc for Select all; asked first.
  assert.match(s, /if \(off\) sp\.set\("onlist", "dnc"\)/);
  assert.match(s, /type: "market\.moveAll", list: "market", query: sp\.toString\(\), to: "Not on a list", dncOnly: true/);
  assert.match(s, /type: "market\.move", ids, to: "Not on a list", dncOnly: true/);
  assert.match(s, /Take \$\{who\} off your DNC List\?/);
  // Add from your market: as before — no limit, asked first.
  assert.match(s, /type: "market\.moveAll", list: "market", query: sp\.toString\(\), to: "DNC List"/);
  assert.match(s, /type: "market\.move", ids, to: "DNC List"/);
  assert.match(s, /We'll stop emailing them in every campaign\. This can't be undone\./, "asked first, in Market's words");
  assert.match(s, /off\(tab === "list" \? `\$\{r\.name\} is off your DNC List now\.` : `\$\{r\.name\} is on your DNC List already\.`\)/);
  assert.doesNotMatch(s, /const cap =|narrow the filters/, "no limit on how many (Sankalp, 24 Nov)");
  assert.match(s, /if \(!allMarked && ids\.length > MAX_TICKED\)/);
  // Every entry: agents and companies in one table, search, Brokerage, select, remove; add by hand and import as before.
  assert.match(s, /<th>Type<\/th>/);
  assert.match(s, /type: "dnc\.delete", ids, bulk: true/);
  assert.match(s, /type: "dnc\.add", kind: "agent"/);
  assert.match(s, /"dnc\.import"/);
  assert.match(setup, /step === 3 \? <DncStep clientId=\{client\.id\} dnc=\{dnc\} \/>/);
  // The server side: the query and the move.
  const model = read("./market-model.ts");
  assert.match(model, /onList: list === "market" && p\.get\("onlist"\) === "dnc" \? "DNC List" : null/);
  const demo = read("./demo.ts");
  assert.match(demo, /if \(to !== "My Agents" && !dncOnly && myRows\.length\)/, "the Demo too: My Agents untouched");
  assert.match(demo, /if \(to !== "Prospects" && !dncOnly\)/);
});

test("Market page: no limit onto any list — only agents ticked one by one are held to the save's 1,000 named agents", () => {
  const m = read("../../components/crm-preview/market.tsx");
  assert.match(m, /const cap = 1000;/, "Select all is never held here");
  assert.match(m, /if \(!one && !allPicked && picked\.size > cap\)/);
});

test("Setup › Who we email: Select all adds every agent that matches — no 10,000 a click (Sankalp, 24 Nov)", () => {
  const s2 = fn(setup, "TargetStep");
  assert.doesNotMatch(setup, /SETUP_MAX_PICK/);
  assert.doesNotMatch(s2, /narrow the filters/);
  assert.match(s2, /type: "market\.moveAll", list: "market", query: sp\.toString\(\), to: "Prospects", setup: true/);
  assert.match(s2, /if \(!allPicked && picked\.size > MAX_TICKED\)/, "only ticks one by one keep the save's limit on named agents");
  assert.match(s2, /window\.confirm\(`Add \$\{who\} to your Prospects/, "asked first, naming how many");
});
