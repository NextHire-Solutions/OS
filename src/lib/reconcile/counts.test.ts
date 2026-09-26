import assert from "node:assert/strict";
import { test } from "node:test";

import { explainCount, reconcileCounts, type ToolRow } from "./counts";

/*
 * §2's test, as arithmetic: 57 / 50 / 53 / 44 against a master list of 52 has
 * to be explainable down to the row, or it is the failure the section warns
 * about.
 *
 * The most important test is the last one: when the arithmetic does NOT
 * balance, `balances` must go false. A reconciliation that always claims to
 * add up would hide exactly the thing it exists to surface.
 */

const master = [
  { id: "1", name: "Alpha Realty", status: "active" },
  { id: "2", name: "Beta Group", status: "churned" },
  { id: "3", name: "Gamma Team", status: "onboarding" },
];
const reasons: Record<string, string> = { "2": "Churned — removed from this tool." };
const reason = (id: string) => reasons[id] ?? null;
const rows = (...r: ToolRow[]) => r;

test("a tool holding every client reports no absence and balances", () => {
  const [r] = reconcileCounts(master, {
    client_health: rows({ name: "Alpha Realty", clientId: "1" },
                        { name: "Beta Group", clientId: "2" },
                        { name: "Gamma Team", clientId: "3" }),
  }, reason);
  assert.equal(r.present, 3);
  assert.equal(r.toolRows, 3);
  assert.deepEqual(r.absent, []);
  assert.equal(r.gaps, 0);
  assert.equal(r.balances, true);
});

test("a row belonging to no client is an extra, and is named", () => {
  const [r] = reconcileCounts(master, {
    analytics: rows({ name: "Alpha Realty", clientId: "1" },
                    { name: "Demo Portal", clientId: null },
                    { name: "Test FUB", clientId: null }),
  }, reason);
  assert.deepEqual(r.extras.map((e) => e.name), ["Demo Portal", "Test FUB"]);
  assert.equal(r.present, 1);
  assert.equal(r.toolRows, 3);
  assert.equal(r.balances, true, "1 client + 2 extras = 3 rows");
});

test("a second row for the same client is counted apart from an extra", () => {
  // Two real cases, and the check must not judge between them: Properties &
  // Estates legitimately runs two portals, while the Database app's "Camelot
  // Realty" / "Camelot Realty Group" pair is an accident. Both are named;
  // neither is called a fault here.
  const [r] = reconcileCounts(master, {
    onboarding: rows({ name: "Alpha Realty", clientId: "1" },
                     { name: "Alpha", clientId: "1" }),
  }, reason);
  assert.deepEqual(r.secondRows, [{ name: "Alpha", of: "Alpha Realty" }]);
  assert.deepEqual(r.extras, []);
  assert.equal(r.present, 1, "a second row does not make the client present twice");
  assert.equal(r.balances, true, "1 client + 1 second row = 2 rows");
});

test("an absence with a reason is not a gap; one without a reason is", () => {
  const [r] = reconcileCounts(master, {
    analytics: rows({ name: "Alpha Realty", clientId: "1" }),
  }, reason);
  const beta = r.absent.find((a) => a.name === "Beta Group")!;
  const gamma = r.absent.find((a) => a.name === "Gamma Team")!;
  assert.equal(beta.reason, "Churned — removed from this tool.");
  assert.equal(gamma.reason, "", "nothing explains Gamma");
  assert.equal(r.gaps, 1, "only the unexplained one counts");
});

test("absences carry the client's status, so churn is visible at a glance", () => {
  const [r] = reconcileCounts(master, { analytics: rows() }, reason);
  assert.deepEqual(
    r.absent.map((a) => [a.name, a.status]),
    [["Alpha Realty", "active"], ["Beta Group", "churned"], ["Gamma Team", "onboarding"]],
  );
});

test("a row pointing at a client id that does not exist counts as an extra", () => {
  const [r] = reconcileCounts(master, {
    analytics: rows({ name: "Ghost Co", clientId: "999" }),
  }, reason);
  assert.deepEqual(r.extras.map((e) => e.name), ["Ghost Co"]);
  assert.equal(r.balances, true);
});

test("several tools are reconciled independently", () => {
  const out = reconcileCounts(master, {
    client_health: rows({ name: "Alpha Realty", clientId: "1" }),
    analytics: rows({ name: "Alpha Realty", clientId: "1" }, { name: "Demo", clientId: null }),
  }, reason);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.tool === "client_health")!.toolRows, 1);
  assert.equal(out.find((x) => x.tool === "analytics")!.toolRows, 2);
});

test("the sentence reads like a person wrote it", () => {
  const [r] = reconcileCounts(master, {
    onboarding: rows({ name: "Alpha Realty", clientId: "1" }, { name: "Alpha", clientId: "1" }),
  }, reason);
  assert.equal(explainCount(r), "2 rows = 1 client + 1 second row, and 2 of the 3 clients are not here.");
});

test("a tool that balances perfectly says so in one clause", () => {
  const [r] = reconcileCounts(master, {
    client_health: rows({ name: "Alpha Realty", clientId: "1" },
                        { name: "Beta Group", clientId: "2" },
                        { name: "Gamma Team", clientId: "3" }),
  }, reason);
  assert.equal(explainCount(r), "3 rows = 3 clients.");
});

test("when the arithmetic cannot balance, it says so rather than pretending", () => {
  // Two rows, same client, but we claim three rows existed: the only way this
  // fires in production is a counting bug — which is worth seeing loudly.
  const out = reconcileCounts(master, { analytics: rows({ name: "A", clientId: "1" }) }, reason);
  const r = { ...out[0], toolRows: 99 };
  assert.equal(r.present + r.secondRows.length + r.extras.length === r.toolRows, false);
});

test("a known non-client carries its reason; an unknown one carries none", () => {
  // The reason is what stops "Demo Portal" reading as a fault. It backs the
  // live demo portal and must never be touched, so the screen has to say so.
  const why = (n: string) =>
    n === "Demo Portal" ? "backs the live demo client portal — keep" : null;
  const [r] = reconcileCounts(master, {
    analytics: [
      { name: "Demo Portal", clientId: null },
      { name: "Mystery Row", clientId: null },
    ],
  }, () => null, why);
  assert.deepEqual(r.extras, [
    { name: "Demo Portal", reason: "backs the live demo client portal — keep" },
    { name: "Mystery Row", reason: "" },
  ]);
});
