/*
 * The Corofy intros feed against a stubbed fetch.
 *
 *   node --import ./scripts/alias-hooks.mjs --test src/lib/tools/client-health/sync/corofy.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { listCorofyIntros } from "./corofy.ts";

const realFetch = globalThis.fetch;
const SAVED = {
  tok: process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN,
  base: process.env.CLIENT_HEALTH_COROFY_BASE_URL,
};

beforeEach(() => {
  process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN = "admin-jwt";
  process.env.CLIENT_HEALTH_COROFY_BASE_URL = "https://corofy.example/";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (SAVED.tok === undefined) delete process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN; else process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN = SAVED.tok;
  if (SAVED.base === undefined) delete process.env.CLIENT_HEALTH_COROFY_BASE_URL; else process.env.CLIENT_HEALTH_COROFY_BASE_URL = SAVED.base;
});

function stub(handler: (url: URL, init: RequestInit | undefined) => { status?: number; body: unknown }) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("no label means the Introduction feed, with the admin token header", async () => {
  const calls = stub(() => ({ body: { ok: true, intros: [{ client_name: "Acme", assigned_at: "2026-09-01T00:00:00Z" }] } }));
  const rows = await listCorofyIntros();
  assert.equal(rows.length, 1);
  assert.equal(calls[0].url.href, "https://corofy.example/api/clients/intros");
  assert.equal(new Headers(calls[0].init?.headers).get("x-admin-token"), "admin-jwt");
});

test("a label is passed as ?label=", async () => {
  const calls = stub(() => ({ body: { ok: true, intros: [] } }));
  await listCorofyIntros("Hired");
  assert.equal(calls[0].url.searchParams.get("label"), "Hired");
});

test("a missing intros array is an empty list, not a crash", async () => {
  stub(() => ({ body: { ok: true } }));
  assert.deepEqual(await listCorofyIntros("Interested"), []);
});

test("a 404 names the label so runCorofy can recognise a missing Hired label", async () => {
  stub(() => ({ status: 404, body: { error: 'Label "Hired" not found' } }));
  await assert.rejects(listCorofyIntros("Hired"), /Corofy \/api\/clients\/intros\?label=Hired 404: .*not found/);
});

test("both variables are required, and checked before any request", async () => {
  const calls = stub(() => ({ body: { intros: [] } }));
  delete process.env.CLIENT_HEALTH_COROFY_BASE_URL;
  await assert.rejects(listCorofyIntros(), /CLIENT_HEALTH_COROFY_BASE_URL is not set/);
  process.env.CLIENT_HEALTH_COROFY_BASE_URL = "https://corofy.example";
  delete process.env.CLIENT_HEALTH_COROFY_ADMIN_TOKEN;
  await assert.rejects(listCorofyIntros(), /CLIENT_HEALTH_COROFY_ADMIN_TOKEN is not set/);
  assert.equal(calls.length, 0);
});
