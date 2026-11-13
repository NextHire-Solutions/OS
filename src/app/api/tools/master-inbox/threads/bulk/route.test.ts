import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";

/*
 * A stop label applied from the selection bar (14 Nov): every selected person is
 * stopped, as labelling one conversation does (inbox/apply-label.ts). Before
 * this the bulk path saved the label and nothing else. Through the real route,
 * against an in-memory database; the stop itself is recorded, never sent.
 */
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const T = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const L: Record<string, string> = {
  Unsubscribe: "a0000000-0000-4000-8000-000000000001",
  Hostile: "a0000000-0000-4000-8000-000000000002",
  "Do Not Contact": "a0000000-0000-4000-8000-000000000003",
  "Add to Blocklist": "a0000000-0000-4000-8000-000000000004",
  "Keep Warm": "a0000000-0000-4000-8000-000000000005",
  Interested: "a0000000-0000-4000-8000-000000000006",
};
const LABELS = Object.entries(L).map(([name, id]) => ({ id, name }));

const saved: Array<{ label_id: string; target_id: string }> = [];
const calls: string[] = [];
const later: Array<() => unknown> = [];
let upsertError: string | null = null;
let throwFor: string | null = null;
let running = 0;
let mostAtOnce = 0;

function from(table: string) {
  let op = "select";
  const ins: Record<string, unknown[]> = {};
  const answer = async () => {
    if (table === "labels") return { data: LABELS.filter((l) => (ins.id ?? []).includes(l.id)), error: null };
    if (table === "label_assignments" && op === "delete") {
      calls.push(`wipe ${(ins.target_id ?? []).length}`);
      return { data: null, error: null };
    }
    return { data: [], error: null };
  };
  const b = {
    select: () => b,
    delete: () => { op = "delete"; return b; },
    eq: () => b,
    in: (column: string, values: unknown[]) => { ins[column] = values; return b; },
    upsert: async (rows: Array<{ label_id: string; target_id: string }>) => {
      if (upsertError) return { error: { message: upsertError } };
      saved.push(...rows);
      return { error: null };
    },
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => answer().then(ok, bad),
  };
  return b;
}

// One at a time is part of the contract: each stop is several provider calls.
const step = async (what: string, id: string) => {
  running++;
  mostAtOnce = Math.max(mostAtOnce, running);
  await new Promise((r) => setTimeout(r, 1));
  running--;
  if (throwFor === id && what === "stop") throw new Error("provider down");
  calls.push(`${what} ${id}`);
};

let POST: (r: Request) => Promise<Response>;
test("setup", { skip }, async () => {
  mock.module("next/server", { namedExports: { NextResponse, after: (task: () => unknown) => { later.push(task); } } });
  mock.module("@/lib/auth/workspace", { namedExports: { requireSession: async () => ({ activeWorkspace: { id: "ws1" }, user: { id: null } }) } });
  mock.module("@/lib/supabase/server", { namedExports: { createServerSupabase: async () => ({ from }) } });
  mock.module("@/lib/supabase/admin", { namedExports: { createAdminSupabase: () => ({ from }) } });
  mock.module("@/lib/tools/master-inbox/inbox/interest", {
    namedExports: {
      isInterestedLabel: (n: string | null) => (n ?? "").trim().toLowerCase() === "interested",
      markEmailBisonReplyInterested: async (id: string, on: boolean) => { calls.push(`interested ${on} ${id}`); },
    },
  });
  mock.module("@/lib/tools/master-inbox/webhooks/n8n-introduction", { namedExports: { notifyIntroductionForThreads: async () => undefined } });
  mock.module("@/lib/tools/master-inbox/integrations/push-pipeline-entry", { namedExports: { pushIntroPipelineEntriesForThreadsToFub: async () => undefined } });
  mock.module("@/lib/tools/master-inbox/webhooks/slack-portal", { namedExports: { notifyPortalIntroductionForThreads: async () => undefined } });
  mock.module("@/lib/tools/master-inbox/inbox/clients", { namedExports: { invalidateInboxClientsCache: () => undefined } });
  mock.module("@/lib/tools/master-inbox/inbox/preserve-pipeline-notes", { namedExports: { snapshotPipelineNotes: async () => null, restorePipelineNotes: async () => undefined } });
  mock.module("@/lib/tools/master-inbox/inbox/dnc", {
    namedExports: {
      isHostileLabel: (n: string | null) => (n ?? "").trim().toLowerCase() === "hostile",
      markThreadLeadDoNotContact: (id: string) => step("dnc", id),
      stopThreadPerson: (id: string) => step("stop", id),
    },
  });
  ({ POST } = await import("./route.ts"));
});

const reset = () => {
  saved.length = 0;
  calls.length = 0;
  later.length = 0;
  upsertError = null;
  throwFor = null;
  mostAtOnce = 0;
};
const label = (name: string, op: "add" | "remove" = "add", ids = T) =>
  POST(new Request("http://os/api/tools/master-inbox/threads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "labels", thread_ids: ids, label_ids: [L[name]], op }),
  }));
const runLater = async () => { for (const task of later.splice(0)) await task(); };
const stops = () => calls.filter((c) => c.startsWith("stop ") || c.startsWith("dnc "));

test("Unsubscribe on three conversations stops all three people, after the answer, one at a time", { skip }, async () => {
  reset();
  const res = await label("Unsubscribe");
  assert.equal(res.status, 200);
  assert.deepEqual(saved.map((r) => r.target_id), T, "the label is saved on every one first");
  assert.deepEqual(stops(), [], "nothing is sent before the answer");
  await runLater();
  assert.deepEqual(stops(), T.map((id) => `stop ${id}`));
  assert.equal(mostAtOnce, 1);
});

test("Hostile also marks each lead do-not-contact on its own platform, before the stop, as one conversation does", { skip }, async () => {
  reset();
  await label("Hostile");
  await runLater();
  assert.deepEqual(stops(), T.flatMap((id) => [`dnc ${id}`, `stop ${id}`]));
});

test("Do Not Contact and Add to Blocklist stop the person too", { skip }, async () => {
  for (const name of ["Do Not Contact", "Add to Blocklist"]) {
    reset();
    await label(name);
    await runLater();
    assert.deepEqual(stops(), T.map((id) => `stop ${id}`), name);
  }
});

test("any other label stops no one", { skip }, async () => {
  for (const name of ["Keep Warm", "Interested"]) {
    reset();
    await label(name);
    await runLater();
    assert.deepEqual(stops(), [], name);
  }
});

test("removing a stop label stops no one", { skip }, async () => {
  reset();
  await label("Unsubscribe", "remove");
  await runLater();
  assert.deepEqual(stops(), []);
});

test("a label that failed to save stops no one", { skip }, async () => {
  reset();
  upsertError = "refused";
  const res = await label("Unsubscribe");
  assert.equal(res.status, 400);
  await runLater();
  assert.deepEqual(stops(), []);
});

test("one person's failure never costs the others their stop", { skip }, async () => {
  reset();
  throwFor = T[0];
  await label("Unsubscribe");
  await runLater();
  assert.deepEqual(stops(), [`stop ${T[1]}`, `stop ${T[2]}`]);
});
