import { test } from "node:test";
import assert from "node:assert/strict";

import { moveLinks, readLinks, type LinkStore, type PortalRoute } from "./links.ts";

function fakeStore(o: { route?: PortalRoute | null; picks?: Awaited<ReturnType<LinkStore["picks"]>>; setups?: Array<{ osClientId: string; mlsCode: string }>; fail?: string[]; changedMeanwhile?: string[]; readFails?: boolean } = {}) {
  const calls: string[] = [];
  const store: LinkStore = {
    route: async () => { if (o.readFails) throw new Error("no table"); return o.route ?? null; },
    saveRoute: async (cid, name, route, by) => { if (o.fail?.includes("route")) throw new Error("route down"); calls.push(`route ${cid} ${name} ${route.miClientId} ${route.source} ${by}`); },
    picks: async () => o.picks ?? [],
    setPick: async (c, m, from, to) => {
      if (o.fail?.includes(`pick:${m}`)) throw new Error("pick down");
      if (o.changedMeanwhile?.includes(`pick:${m}`)) return false;
      calls.push(`pick ${c} ${m || "-"} ${from}->${to}`);
      return true;
    },
    setups: async () => o.setups ?? [],
    setSetup: async (c, m, from, to) => { calls.push(`setup ${c} ${m || "-"} ${from}->${to}`); return true; },
  };
  return { store, calls };
}

test("readLinks finds the portal route, the one Prospects pick and per-MLS picks naming the campaign, and setup records", async () => {
  const { store } = fakeStore({
    route: { osClientId: "c1", miClientId: "p-boston", source: "manual" },
    picks: [
      { osClientId: "c1", single: "1277", byMls: { MIBOR: { id: "1277" }, OTHER: { id: "55" } } },
      { osClientId: "c2", single: "999", byMls: {} },
    ],
    setups: [{ osClientId: "c1", mlsCode: "" }],
  });
  const s = await readLinks(1277, store);
  assert.equal(s.ready, true);
  assert.deepEqual(s.portalRoute, { osClientId: "c1", miClientId: "p-boston", source: "manual" });
  assert.deepEqual(s.picks, [{ osClientId: "c1", mlsCode: "" }, { osClientId: "c1", mlsCode: "MIBOR" }]);
  assert.deepEqual(s.setups, [{ osClientId: "c1", mlsCode: "" }]);
});

test("readLinks that cannot read says so (the run is then not offered)", async () => {
  const s = await readLinks(1, fakeStore({ readFails: true }).store);
  assert.equal(s.ready, false);
  assert.equal(s.error, "no table");
});

test("moveLinks copies the portal choice (same portal, same source) and moves each pick and setup record", async () => {
  const { store, calls } = fakeStore();
  const state = await readLinks(1277, fakeStore({ route: { osClientId: "c1", miClientId: "p1", source: "manual" }, picks: [{ osClientId: "c1", single: "1277", byMls: { MIBOR: { id: "1277" } } }], setups: [{ osClientId: "c1", mlsCode: "" }] }).store);
  const r = await moveLinks(1277, 2001, "LIV Indy Realty + X", "amy@x.com", state, store);
  assert.deepEqual(r, { portal: "copied", picksMoved: 2, setupsMoved: 1, errors: [] });
  assert.deepEqual(calls, [
    "route 2001 LIV Indy Realty + X p1 manual amy@x.com (Duplicate & Renew from #1277)",
    "pick c1 - 1277->2001",
    "pick c1 MIBOR 1277->2001",
    "setup c1 - 1277->2001",
  ]);
});

test("no links: nothing written, nothing said", async () => {
  const { store, calls } = fakeStore();
  const r = await moveLinks(1, 2, "n", "a", { ready: true, error: null, portalRoute: null, picks: [], setups: [] }, store);
  assert.deepEqual(r, { portal: "none", picksMoved: 0, setupsMoved: 0, errors: [] });
  assert.deepEqual(calls, []);
});

test("a failure or a change made meanwhile is told, and never stops the other links", async () => {
  const { store, calls } = fakeStore({ fail: ["route", "pick:A"], changedMeanwhile: ["pick:B"] });
  const state = { ready: true, error: null, portalRoute: { osClientId: "c", miClientId: "p", source: "auto" as const }, picks: [{ osClientId: "c", mlsCode: "A" }, { osClientId: "c", mlsCode: "B" }, { osClientId: "c", mlsCode: "C" }], setups: [{ osClientId: "c", mlsCode: "" }] };
  const r = await moveLinks(1, 2, "n", "a", state, store);
  assert.equal(r.portal, "failed");
  assert.equal(r.picksMoved, 1);
  assert.equal(r.setupsMoved, 1);
  assert.deepEqual(r.errors, [
    "Portal choice not copied: route down",
    "Prospects pick for A not moved: pick down",
    "Prospects pick for B was changed by someone meanwhile, so it was left as they set it.",
  ]);
  assert.deepEqual(calls, ["pick c C 1->2", "setup c - 1->2"]);
});
