/*
 * Where the portals list comes from, and the external path's degrade-to-empty
 * contract. The in-process Master Inbox path is a route handler and is not
 * loaded here; its selection IS tested, because picking the wrong source
 * silently flips every portal_active flag.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/portals.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { listCorofyPortals, portalsSource } from "./portals.ts";

const realFetch = globalThis.fetch;
const KEYS = [
  "MASTER_INBOX_SUPABASE_URL", "MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY",
  "CLIENT_HEALTH_COROFY_BASE_URL", "CLIENT_HEALTH_COROFY_ADMIN_TOKEN",
];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const env = (map: Record<string, string>) => (k: string) => map[k];

test("the workspace's own Master Inbox route wins when it is configured", () => {
  assert.equal(
    portalsSource(env({
      MASTER_INBOX_SUPABASE_URL: "u", MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY: "k",
      CLIENT_HEALTH_COROFY_BASE_URL: "c", CLIENT_HEALTH_COROFY_ADMIN_TOKEN: "t",
    })),
    "master-inbox",
  );
});

test("the tool's external call is the fallback, and only with BOTH Corofy variables", () => {
  assert.equal(portalsSource(env({ CLIENT_HEALTH_COROFY_BASE_URL: "c", CLIENT_HEALTH_COROFY_ADMIN_TOKEN: "t" })), "corofy");
  assert.equal(portalsSource(env({ CLIENT_HEALTH_COROFY_BASE_URL: "c" })), null);
  assert.equal(portalsSource(env({ MASTER_INBOX_SUPABASE_URL: "u", CLIENT_HEALTH_COROFY_ADMIN_TOKEN: "t" })), null,
    "half a Master Inbox config does not select it, and half a Corofy config does not either");
  assert.equal(portalsSource(env({})), null);
});

test("the external path returns the clients array, or [] on any failure", async () => {
  for (const k of KEYS) delete process.env[k];
  process.env.CLIENT_HEALTH_COROFY_BASE_URL = "https://corofy.example/";
  process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN = "jwt";

  let seen: { url: string; token: string | null } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), token: new Headers(init?.headers).get("x-admin-token") };
    return new Response(JSON.stringify({ ok: true, count: 1, clients: [{ id: "p1", name: "Acme", portal_enabled: true }] }), { status: 200 });
  }) as typeof fetch;
  const portals = await listCorofyPortals();
  assert.equal(portals.length, 1);
  assert.deepEqual(seen, { url: "https://corofy.example/api/clients/portals", token: "jwt" });

  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  assert.deepEqual(await listCorofyPortals(), [], "non-2xx degrades to empty");

  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.deepEqual(await listCorofyPortals(), [], "network failure degrades to empty");
});

test("with nothing configured, nothing is called", async () => {
  for (const k of KEYS) delete process.env[k];
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  assert.deepEqual(await listCorofyPortals(), []);
  assert.equal(called, false);
});
