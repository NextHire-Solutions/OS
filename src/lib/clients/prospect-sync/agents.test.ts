import { test } from "node:test";
import assert from "node:assert/strict";

import { shownCampaigns } from "./agents.ts";

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
