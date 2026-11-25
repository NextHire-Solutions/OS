/* Without CLIENT_HEALTH_DB: Client Health's own project, exactly as before the merge (its default schema, public). */
import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.CLIENT_HEALTH_DB;
process.env.MASTER_INBOX_SUPABASE_URL = "https://mi-test.supabase.co";
process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY = "mi-key";
process.env.CLIENT_HEALTH_SUPABASE_URL = "https://ch-test.supabase.co";
process.env.CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY = "ch-key";

const seen: Array<{ url: string; headers: Record<string, string> }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { getSupabase, clientHealthInMasterInbox, clientHealthDbEnv } = await import("./supabase.ts");

test("setting absent: Client Health's own project, its key, the public schema", async () => {
  assert.equal(clientHealthInMasterInbox(), false);
  await getSupabase().from("clients").select("id");
  const r = seen.at(-1)!;
  assert.ok(r.url.startsWith("https://ch-test.supabase.co/rest/v1/clients"), r.url);
  assert.equal(r.headers.apikey, "ch-key");
  assert.equal(r.headers["accept-profile"] ?? "public", "public", "the default schema, as today");
  assert.deepEqual(clientHealthDbEnv(), ["CLIENT_HEALTH_SUPABASE_URL", "CLIENT_HEALTH_SUPABASE_SERVICE_ROLE_KEY"]);
});
