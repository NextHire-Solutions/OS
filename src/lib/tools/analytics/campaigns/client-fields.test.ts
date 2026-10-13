import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NO_CLIENT, clientFieldValues, clientFieldsIn, clientFieldsProblem, fillClientFields, fillSteps, listAreas, unfilledProblem, usesClientFields,
} from "./client-fields.ts";

const WAGNER = clientFieldValues({ name: "Wagner Real Estate Group", aliases: ["Wagner"], areas: ["greater Seattle"] });

test("areas read as a sentence", () => {
  assert.equal(listAreas(["Boston"]), "Boston");
  assert.equal(listAreas(["Boston", "Cape Cod"]), "Boston and Cape Cod");
  assert.equal(listAreas(["Boston", "Cape Cod", "the Islands"]), "Boston, Cape Cod and the Islands");
  assert.equal(listAreas([" Boston ", "", "Boston", null, 7]), "Boston", "trimmed, blanks dropped, one of each");
  assert.equal(listAreas([]), null);
  assert.equal(listAreas(null), null);
});

test("a client's values: its areas, and its first alias — or its name when it has none", () => {
  assert.deepEqual(WAGNER, { clientName: "Wagner Real Estate Group", area: "greater Seattle", alias: "Wagner" });
  assert.equal(clientFieldValues({ name: "Oz Group", aliases: [], areas: [] }).alias, "Oz Group");
  assert.equal(clientFieldValues({ name: "Oz Group", aliases: ["", "  ", "Oz"], areas: null }).alias, "Oz");
  assert.equal(clientFieldValues({ name: "Oz Group" }).area, null);
  assert.deepEqual(clientFieldValues(null), NO_CLIENT);
});

test("finding the fields: any case, space or underscore, spaces inside the braces", () => {
  assert.deepEqual(clientFieldsIn("Agents in {CLIENT_AREA} trust {CLIENT_ALIAS}."), ["area", "alias"]);
  assert.deepEqual(clientFieldsIn("in {client area}"), ["area"]);
  assert.deepEqual(clientFieldsIn("at { Client_Alias }"), ["alias"]);
  assert.deepEqual(clientFieldsIn("Hi {FIRST_NAME}, {a|b} {TOP PRODUCING CITY}"), [], "lead fields and spintax are not client fields");
  assert.deepEqual(clientFieldsIn("{CLIENT_AREAS} {CLIENTAREA} {CLIENT_AREA|x}"), [], "near misses are left alone");
  assert.deepEqual(clientFieldsIn(null), []);
  assert.equal(usesClientFields(["plain", null, "in {CLIENT_AREA}"]), true);
  assert.equal(usesClientFields(["plain", "{FIRST_NAME}"]), false);
});

test("filling: every occurrence replaced, everything else exactly as written", () => {
  const out = fillClientFields("Hi {FIRST_NAME} — {CLIENT_ALIAS} is hiring in {CLIENT_AREA}. {yes|sure}, {client area}!", WAGNER);
  assert.equal(out.value, "Hi {FIRST_NAME} — Wagner is hiring in greater Seattle. {yes|sure}, greater Seattle!");
  assert.equal(out.filled, 3);
  assert.deepEqual(out.missing, []);
});

test("a value containing $ or braces is inserted literally", () => {
  const odd = { clientName: "X", area: "$1 {city} $&", alias: "A&B" };
  assert.equal(fillClientFields("in {CLIENT_AREA} with {CLIENT_ALIAS}", odd).value, "in $1 {city} $& with A&B");
});

test("text with no client field is handed back untouched — the very same string", () => {
  const text = "Hi {FIRST_NAME}, quick question about {TOP PRODUCING CITY}.";
  const out = fillClientFields(text, WAGNER);
  assert.equal(out.value, text);
  assert.equal(out.filled, 0);
  assert.deepEqual(out.missing, []);
});

test("a field the client has no value for stays as written and is reported — never blanked", () => {
  const noArea = clientFieldValues({ name: "Oz Group", aliases: ["Oz"], areas: [] });
  const out = fillClientFields("{CLIENT_ALIAS} is hiring in {CLIENT_AREA}.", noArea);
  assert.equal(out.value, "Oz is hiring in {CLIENT_AREA}.");
  assert.equal(out.filled, 1);
  assert.deepEqual(out.missing, ["area"]);
});

test("a template (no client) keeps every placeholder", () => {
  const out = fillClientFields("{CLIENT_ALIAS} in {CLIENT_AREA}", NO_CLIENT);
  assert.equal(out.value, "{CLIENT_ALIAS} in {CLIENT_AREA}");
  assert.equal(out.filled, 0);
  assert.deepEqual(out.missing, ["area", "alias"]);
  assert.equal(clientFieldsProblem(out.missing, NO_CLIENT), null, "not a problem: it is filled when copied to a client");
});

test("steps: subjects and bodies filled, every other property kept", () => {
  const steps = [
    { id: 1, email_subject: "{CLIENT_ALIAS} x {FIRST_NAME}", email_body: "<p>In {CLIENT_AREA}</p>", wait_in_days: 2, variant: false },
    { id: 2, email_subject: "Re: hi", email_body: "<p>Nothing here</p>", wait_in_days: 3, variant: true },
  ];
  const out = fillSteps(steps, WAGNER);
  assert.equal(out.filled, 2);
  assert.deepEqual(out.value[0], { id: 1, email_subject: "Wagner x {FIRST_NAME}", email_body: "<p>In greater Seattle</p>", wait_in_days: 2, variant: false });
  assert.equal(out.value[1], steps[1], "an untouched step is the same object");
});

test("steps with no client field: the very same array, nothing counted", () => {
  const steps = [{ email_subject: "Hi {FIRST_NAME}", email_body: "<p>{a|b}</p>" }];
  const out = fillSteps(steps, WAGNER);
  assert.equal(out.value, steps);
  assert.equal(out.filled, 0);
  assert.deepEqual(out.missing, []);
});

test("steps: missing fields are gathered once across the whole sequence", () => {
  const noArea = clientFieldValues({ name: "Oz Group", areas: [] });
  const out = fillSteps([{ email_subject: "{CLIENT_AREA}", email_body: "{CLIENT_AREA} {CLIENT_ALIAS}" }, { email_subject: null, email_body: "{client area}" }], noArea);
  assert.deepEqual(out.missing, ["area"]);
  assert.equal(out.filled, 1);
  assert.equal(out.value[0].email_body, "{CLIENT_AREA} Oz Group");
});

test("the refusal names the client, the field and where to fix it", () => {
  const noArea = clientFieldValues({ name: "Oz Group", areas: [] });
  assert.equal(
    clientFieldsProblem(["area"], noArea),
    "Oz Group has nothing on record for {CLIENT_AREA} (client area), so the sequence cannot be saved with it. Add an Area on the client's record (Clients → the client → Markets), or take the field out.",
  );
  assert.equal(clientFieldsProblem([], noArea), null);
});

test("a campaign still holding a placeholder must not send", () => {
  assert.equal(unfilledProblem([]), null);
  assert.match(unfilledProblem(["area", "alias"])!, /^The sequence still contains \{CLIENT_AREA\} and \{CLIENT_ALIAS\}\./);
});
