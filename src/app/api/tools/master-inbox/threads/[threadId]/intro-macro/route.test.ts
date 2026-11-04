import { test, mock } from "node:test";
import assert from "node:assert/strict";

// What the composer's Introduce button is told, through the real route and the
// real roster read, against an in-memory database.
const canMock = typeof mock.module === "function";
const skip = canMock ? false : "needs node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs";

const WS = "ws1";
const ROW: Record<string, unknown> = {
  id: "c1", name: "FAST Real Estate", brokerage: "FAST Real Estate", mi_client_id: "mi1",
  contact_name: "Elias Astuto", contact_role: "Director of Sales", contact_email: "e@example.com",
  intro_subject: "Connecting you with #TEAMFAST | {{lead.name}}", relay_settings: null, pipeline_entry: null,
};
let columnExists = true;
const selected: string[] = [];

function from(table: string) {
  let asked = "";
  const answer = async () => {
    if (table === "threads") return { data: { id: "t1", workspace_id: WS, client_id: "mi1", source_provider: "emailbison", campaign_name: "FAST + East Bay" }, error: null };
    if (table === "clients") return { data: { id: "mi1", name: "FAST Real Estate" }, error: null };
    if (table === "labels") return { data: { id: "l1" }, error: null };
    if (table === "os_clients") {
      selected.push(asked);
      if (!columnExists && asked.includes("intro_subject")) return { data: null, error: { message: "column os_clients.intro_subject does not exist" } };
      return { data: columnExists ? ROW : { ...ROW, intro_subject: undefined }, error: null };
    }
    return { data: null, error: null };
  };
  const b = {
    select: (c?: string) => { asked = c ?? ""; return b; },
    eq: () => b, ilike: () => b, limit: () => b,
    maybeSingle: answer,
  };
  return b;
}

let GET: (r: Request, c: { params: Promise<{ threadId: string }> }) => Promise<Response>;
const ask = async () => (await (await GET(new Request("http://x/"), { params: Promise.resolve({ threadId: "t1" }) })).json()) as Record<string, unknown>;

test("setup", { skip }, async () => {
  const up = "../../../../../../../lib";
  mock.module(`${up}/auth/workspace`, { namedExports: { requireSession: async () => ({ activeWorkspace: { id: WS } }) } });
  mock.module(`${up}/supabase/admin`, { namedExports: { createAdminSupabase: () => ({ from }) } });
  mock.module(`${up}/clients/os-db`, { namedExports: { osTable: from } });
  mock.module(`${up}/tools/master-inbox/inbox/intro-sender`, { namedExports: { introSenderFor: async () => ({ email: "n@example.com", channelId: "ch1", problem: null }) } });
  mock.module(`${up}/tools/master-inbox/relay/settings`, { namedExports: { directHandoffReason: () => null } });
  ({ GET } = await import("./route"));
});

test("the button is told the client's own subject", { skip }, async () => {
  selected.length = 0;
  const body = await ask();
  assert.equal(body.available, true);
  assert.equal(body.subject, "Connecting you with #TEAMFAST | {{lead.name}}");
  assert.equal(body.brokerage, "FAST Real Estate");
  assert.ok(selected[0].includes("intro_subject"));
});

test("no subject of its own: told null, so it builds the standard one", { skip }, async () => {
  const saved = ROW.intro_subject;
  ROW.intro_subject = null;
  try {
    const body = await ask();
    assert.equal(body.available, true);
    assert.equal(body.subject, null);
  } finally {
    ROW.intro_subject = saved;
  }
});

test("the column not existing yet: the button still works, with the standard subject", { skip }, async () => {
  columnExists = false;
  try {
    const body = await ask();
    assert.equal(body.available, true);
    assert.equal(body.subject, null);
  } finally {
    columnExists = true;
  }
});
