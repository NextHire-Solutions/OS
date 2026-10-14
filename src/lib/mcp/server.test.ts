/*
 * The Claude connector (15 Oct): the protocol, what Claude is offered, and
 * which paths the proxy opens for it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { handleMcpBody, type McpContext } from "./server.ts";

const calls: Array<[string, Record<string, unknown>]> = [];
const ctx: McpContext = {
  tools: [
    { name: "find_client", description: "Resolve a client name", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "broken", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  ],
  instructions: "The briefing.",
  call: async (name, args) => {
    calls.push([name, args]);
    if (name === "broken") throw new Error("Client Health did not respond");
    return { match: { name: "Jeff Cook Real Estate" } };
  },
};

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

/* ---------------------------------------------------------------- protocol --- */

test("initialize: the version Claude asks for when we speak it, the latest otherwise; tools and the briefing", async () => {
  const r = (await handleMcpBody(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-ai" } }), ctx)) as any;
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, "brokerstaffer-os");
  assert.equal(r.result.instructions, "The briefing.");
  const future = (await handleMcpBody(rpc("initialize", { protocolVersion: "2099-01-01" }), ctx)) as any;
  assert.equal(future.result.protocolVersion, "2025-06-18");
});

test("notifications get no answer (the route sends 202); ping, tools/list", async () => {
  assert.equal(await handleMcpBody({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx), null);
  assert.deepEqual(((await handleMcpBody(rpc("ping"), ctx)) as any).result, {});
  const list = (await handleMcpBody(rpc("tools/list"), ctx)) as any;
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ["find_client", "broken"]);
});

test("tools/call runs the tool with its arguments and returns its answer as text", async () => {
  calls.length = 0;
  const r = (await handleMcpBody(rpc("tools/call", { name: "find_client", arguments: { query: "jeff cook" } }, "a"), ctx)) as any;
  assert.equal(r.id, "a");
  assert.deepEqual(calls, [["find_client", { query: "jeff cook" }]]);
  assert.equal(r.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.result.content[0].text), { match: { name: "Jeff Cook Real Estate" } });
  assert.equal(r.result.isError, undefined);
});

test("a failing tool is an answer Claude can relay (isError), not a protocol failure", async () => {
  const r = (await handleMcpBody(rpc("tools/call", { name: "broken", arguments: {} }), ctx)) as any;
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Client Health did not respond/);
});

test("an unknown tool or method, or a malformed message, is a JSON-RPC error — and nothing runs", async () => {
  calls.length = 0;
  assert.equal(((await handleMcpBody(rpc("tools/call", { name: "delete_everything" }), ctx)) as any).error.code, -32602);
  assert.equal(((await handleMcpBody(rpc("sampling/createMessage"), ctx)) as any).error.code, -32601);
  assert.equal(((await handleMcpBody({ id: 1, method: "ping" }, ctx)) as any).error.code, -32600);
  assert.equal(((await handleMcpBody("nonsense", ctx)) as any).error.code, -32600);
  assert.deepEqual(calls, []);
});

test("a batch is answered message by message, notifications left out", async () => {
  const r = (await handleMcpBody([rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("tools/list", undefined, 2)], ctx)) as any[];
  assert.deepEqual(r.map((m) => m.id), [1, 2]);
});

/* ------------------------------------------------------------ what Claude gets --- */

test("Claude is offered every Assistant tool plus the guide, every one marked read-only, with a valid input schema", async () => {
  const { mcpTools, INSTRUCTIONS, runMcpTool } = await import("./tools.ts");
  const { TOOL_SCHEMA, SYSTEM_PROMPT } = await import("@/lib/tools/assistant/engine");
  const tools = mcpTools();
  assert.equal(tools.length, TOOL_SCHEMA.length + 1);
  assert.equal(tools[0].name, "os_guide");
  const names = new Set(tools.map((t) => t.name));
  for (const { function: f } of TOOL_SCHEMA) assert.ok(names.has(f.name), f.name);
  assert.equal(names.size, tools.length, "no duplicate names");
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
    assert.equal((t.inputSchema as { type?: string }).type, "object", t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.match(t.name, /^[a-z0-9_]{1,64}$/, t.name);
  }
  // The whole briefing reaches Claude, both ways.
  assert.ok(INSTRUCTIONS.includes(SYSTEM_PROMPT));
  assert.match(INSTRUCTIONS, /READ-ONLY/);
  assert.equal(await runMcpTool("os_guide", {}), INSTRUCTIONS);
  await assert.rejects(runMcpTool("no_such_tool", {}), /No tool named no_such_tool/);
});

/* ------------------------------------------------------------------ the proxy --- */

test("the proxy lets Claude reach the token-checked endpoints, and still guards the Allow page and its POST", async () => {
  process.env.AUTH_SECRET = "test-secret-that-is-long-enough-for-hmac";
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const at = (path: string, method = "GET") => proxy(new NextRequest(new URL(path, "https://os.brokerstaffer.com"), { method }));
  const open = (r: Response) => r.headers.get("x-middleware-next") === "1";

  for (const path of ["/api/mcp", "/api/oauth/token", "/api/oauth/register", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-authorization-server"]) {
    assert.ok(open(await at(path, path.startsWith("/.well") ? "GET" : "POST")), path);
  }
  const page = await at("/oauth/authorize?client_id=x");
  assert.equal(open(page), false);
  assert.match(page.headers.get("location") ?? "", /\/login\?next=%2Foauth%2Fauthorize/);
  const allow = await at("/api/oauth/authorize", "POST");
  assert.equal(allow.status, 401, "pressing Allow needs an OS session");
  // Nothing else became public by accident.
  for (const path of ["/api/mcpx", "/api/oauth", "/api/tools/assistant/chats", "/clients"]) {
    assert.equal(open(await at(path)), false, path);
  }
});
