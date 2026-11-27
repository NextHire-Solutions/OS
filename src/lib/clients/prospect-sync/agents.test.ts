import { test } from "node:test";
import assert from "node:assert/strict";

import { dropCampaignRecords, fitsPortal, forgetListings, shownCampaigns } from "./agents.ts";
import type { ShownCampaign } from "./queue.ts";

/** A stand-in for the agent database's API: rows per table, served a page (range) at a time, every call recorded. */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ table: string; from: number; to: number; ids: string[] }> = [];
  const from = (table: string) => {
    const q = { ids: [] as string[], filters: {} as Record<string, unknown> };
    const chain = {
      select: () => chain,
      eq: (col: string, v: unknown) => { q.filters[col] = v; return chain; },
      in: (_col: string, ids: string[]) => { q.ids = ids; return chain; },
      order: () => chain,
      range: (a: number, b: number) => {
        calls.push({ table, from: a, to: b, ids: q.ids });
        const rows = (tables[table] ?? []).filter((r) => r.client_id === q.filters.client_id && q.ids.includes(String(r.agent_id)));
        return Promise.resolve({ data: rows.slice(a, b + 1), error: null });
      },
    };
    return chain;
  };
  return { calls, db: { from } as never };
}

test("the campaigns an agent is shown in: every row, page by page (60 campaigns × 20 agents is past a page) — with the address each EmailBison lead there has", async () => {
  const agents = Array.from({ length: 150 }, (_, i) => `a${i}`);
  const campaigns = Array.from({ length: 60 }, (_, i) => String(100 + i));
  const listed = agents.flatMap((a) => campaigns.map((c) => ({ client_id: "orch", agent_id: a, campaign_id: c, campaign_name: `Keyes ${c}`, provider: "EmailBison" })));
  listed.push({ client_id: "orch", agent_id: "a0", campaign_id: "uuid-1", campaign_name: "Keyes + Nicole", provider: "Instantly" });
  listed.push({ client_id: "other", agent_id: "a1", campaign_id: "999", campaign_name: "Not theirs", provider: "EmailBison" });
  const leads = agents.flatMap((a) => campaigns.map((c, j) => ({ id: `${a}-${j}`, client_id: "orch", agent_id: a, campaign_id: c, email: `${a}@x.test` })));
  const { calls, db } = fakeDb({ v_agent_campaigns: listed, bison_client_leads: leads });
  const out = await shownCampaigns("orch", agents, db);
  assert.equal(out.size, 150);
  assert.ok([...out.values()].every((l) => l.filter((c) => c.provider === "emailbison").length === 60), "none cut off at a page's end");
  assert.deepEqual(out.get("a0")!.find((c) => c.provider === "instantly"), { provider: "instantly", id: "uuid-1", name: "Keyes + Nicole" });
  assert.deepEqual(out.get("a7")!.find((c) => c.id === "105"), { provider: "emailbison", id: "105", name: "Keyes 105", emails: ["a7@x.test"] });
  assert.ok(!out.get("a1")!.some((c) => c.id === "999"), "another client's — never");
  assert.ok(calls.every((c) => c.ids.length <= 20), "a short list of agents a request");
  assert.ok(calls.some((c) => c.from === 1000), "a second page asked for");
});

/**
 * A stand-in for the agent database's API that records each delete (table, client, agents, campaigns) and answers the
 * lead-list check's counts: the client's lead list, its campaign records, and one record per agent × campaign asked.
 */
function deletesDb(o: { fail?: string; leadList?: number; records?: number } = {}) {
  const deletes: Array<{ table: string; client: unknown; agents: string[]; campaigns: string[] }> = [];
  const counts: string[] = [];
  const from = (table: string) => {
    const q = { eq: {} as Record<string, unknown>, in: {} as Record<string, string[]>, deleting: false, counting: false };
    const chain = {
      delete: () => { q.deleting = true; return chain; },
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => { q.counting = opts?.count === "exact" && !!opts.head; return chain; },
      eq: (col: string, v: unknown) => { q.eq[col] = v; return chain; },
      not: () => chain,
      in: (col: string, v: string[]) => { q.in[col] = v; return chain; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (q.counting) {
          counts.push(table);
          const count = table === "orch_client_leads" ? (o.leadList ?? 0) : table === "v_agent_campaigns" ? (o.records ?? 1000) : (q.in.agent_id ?? []).length * (q.in.campaign_id ?? []).length;
          return Promise.resolve({ count, error: null }).then(res, rej);
        }
        assert.ok(q.deleting, "only deletes and counts here");
        deletes.push({ table, client: q.eq.client_id, agents: q.in.agent_id, campaigns: q.in.campaign_id });
        return Promise.resolve({ error: table === o.fail ? { message: "the database did not answer" } : null }).then(res, rej);
      },
    };
    return chain;
  };
  return { deletes, counts, db: { from } as never };
}
const eb = (id: string): ShownCampaign => ({ provider: "emailbison", id, name: `Bastion ${id}` });
const inst = (id: string): ShownCampaign => ({ provider: "instantly", id, name: `Bastion + Nicole ${id}` });
const PORTAL = "portal-1";

test("letting go of prospects (27 Nov): this client's record of each agent in the campaigns the portal showed it in — EmailBison's and Instantly's, agents with the same campaigns together", async () => {
  const { deletes, db } = deletesDb();
  const shown = new Map([["a1", [eb("101"), eb("100"), inst("u1")]], ["a2", [eb("100"), eb("101")]], ["a3", [inst("u1")]], ["a4", [] as ShownCampaign[]]]);
  const n = await forgetListings({ orchClientId: "orch-bastion", osClientId: "os-bastion", portalId: PORTAL, shown }, { db, routes: async () => [] });
  assert.deepEqual(n, { emailbison: 2, instantly: 2 });
  assert.deepEqual(deletes, [
    { table: "bison_client_leads", client: "orch-bastion", agents: ["a1", "a2"], campaigns: ["100", "101"] },
    { table: "instantly_client_leads", client: "orch-bastion", agents: ["a1", "a3"], campaigns: ["u1"] },
  ]);
});

test("letting go, a client with several portals: only the EmailBison campaigns routed to this portal (another portal's keep their record, as the run leaves them); Instantly's all", async () => {
  const { deletes, db } = deletesDb();
  const routes = async () => [{ campaignId: "100", portalId: PORTAL }, { campaignId: "200", portalId: "portal-2" }];
  const shown = new Map([["a1", [eb("100"), eb("200"), inst("u1")]], ["a2", [eb("200")]]]);
  const n = await forgetListings({ orchClientId: "orch", osClientId: "os", portalId: PORTAL, shown }, { db, routes });
  assert.deepEqual(n, { emailbison: 1, instantly: 1 });
  assert.deepEqual(deletes.map((d) => [d.table, d.agents, d.campaigns]), [["bison_client_leads", ["a1"], ["100"]], ["instantly_client_leads", ["a1"], ["u1"]]]);
  // A campaign routed nowhere, at a client with several portals, is not this portal's either (run.ts's own rule).
  assert.equal(fitsPortal([{ campaignId: "100", portalId: PORTAL }, { campaignId: "200", portalId: "portal-2" }], PORTAL)("300"), false);
  assert.equal(fitsPortal([], PORTAL)("300"), true, "one portal: every campaign");
  assert.equal(fitsPortal([{ campaignId: "200", portalId: "portal-2" }], PORTAL)("200"), false, "a client whose only route is another portal's");
});

test("letting go: Instantly only — the routes are never read; nothing shown — nothing deleted; a failure is thrown (the save logs it, the run drops the record later)", async () => {
  const { deletes, db } = deletesDb();
  let read = 0;
  const routes = async () => { read++; return []; };
  assert.deepEqual(await forgetListings({ orchClientId: "orch", osClientId: "os", portalId: PORTAL, shown: new Map([["a1", [inst("u1")]]]) }, { db, routes }), { emailbison: 0, instantly: 1 });
  assert.equal(read, 0);
  assert.deepEqual(await forgetListings({ orchClientId: "orch", osClientId: "os", portalId: PORTAL, shown: new Map() }, { db, routes }), { emailbison: 0, instantly: 0 });
  assert.equal(deletes.length, 1);
  const failing = deletesDb({ fail: "bison_client_leads" });
  await assert.rejects(forgetListings({ orchClientId: "orch", osClientId: "os", portalId: PORTAL, shown: new Map([["a1", [eb("100")]]]) }, { db: failing.db, routes }), /bison_client_leads: the database did not answer/);
});

test("dropping campaign records: 150 agents a request (the API's URL limit), never one with no campaigns", async () => {
  const { deletes, db } = deletesDb();
  const many = new Map<string, readonly string[]>(Array.from({ length: 400 }, (_, i) => [`a${i}`, ["100"]] as const));
  many.set("none", []);
  assert.equal(await dropCampaignRecords("bison_client_leads", "orch", many, db), 400);
  assert.deepEqual(deletes.map((d) => d.agents.length), [150, 150, 100]);
  assert.ok(deletes.every((d) => d.client === "orch" && !d.agents.includes("none")));
});

test("the lead-list trap: never a client's last campaign records while it has a lead list (its Prospects would become that list) — nothing dropped, and why; with no lead list, one count and on", async () => {
  const shown = new Map([["a1", [eb("100"), inst("u1")]], ["a2", [eb("100")]]]);
  const args = { orchClientId: "orch", osClientId: "os", portalId: PORTAL, shown };
  // No lead list: only that is counted, then dropped.
  const plain = deletesDb({ leadList: 0, records: 3 });
  assert.deepEqual(await forgetListings(args, { db: plain.db, routes: async () => [] }), { emailbison: 2, instantly: 1 });
  assert.deepEqual(plain.counts, ["orch_client_leads"]);
  // A lead list, and these are its last 3 records: kept.
  const last = deletesDb({ leadList: 1634, records: 3 });
  const kept = await forgetListings(args, { db: last.db, routes: async () => [] });
  assert.deepEqual([kept.emailbison, kept.instantly, last.deletes.length], [0, 0, 0]);
  assert.match(String(kept.keptFor), /whole lead list \(1634\)/);
  // A lead list, but records stay after: dropped.
  const more = deletesDb({ leadList: 1634, records: 4 });
  assert.deepEqual(await forgetListings(args, { db: more.db, routes: async () => [] }), { emailbison: 2, instantly: 1 });
  assert.deepEqual(more.counts, ["orch_client_leads", "v_agent_campaigns", "bison_client_leads", "instantly_client_leads"]);
});
