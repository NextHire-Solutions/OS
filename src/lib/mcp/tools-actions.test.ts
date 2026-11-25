/*
 * The connector per person (25 Nov): actions only when switched on (OS_MCP_ACTIONS) and only for people who may do the
 * same on the OS screen; a person named for the connector reads only what their switches open (the Assistant's rules).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { mcpTools, instructionsFor, runMcpTool } = await import("./tools.ts");
const { NAMED_PAGES, holdsPage } = await import("@/lib/identity/named-pages");

const ADMIN = { email: "owner@example.com", admin: true, grants: [] as string[], billing: true };
const INBOX_ONLY = { email: "teammate@example.com", admin: false, grants: ["inbox"], billing: false };
const HEALTH_ONLY = { email: "am@example.com", admin: false, grants: ["clients"], billing: false };
const ACTIONS = ["inbox_set_label", "inbox_snooze", "client_campaigns"];
const names = (v: typeof ADMIN) => mcpTools(v).map((t) => t.name);

test("actions switched off (OS_MCP_ACTIONS unset): no action tool for anyone, and the briefing says READ-ONLY", () => {
  delete process.env.OS_MCP_ACTIONS;
  for (const v of [ADMIN, INBOX_ONLY]) {
    assert.ok(!names(v).some((n) => ACTIONS.includes(n)));
    assert.match(instructionsFor(v), /READ-ONLY/);
  }
});

test("switched on: an admin gets all three, each marked not read-only; the briefing explains preview then confirm", () => {
  process.env.OS_MCP_ACTIONS = ACTIONS.join(",");
  const tools = mcpTools(ADMIN);
  for (const a of ACTIONS) {
    const t = tools.find((x) => x.name === a);
    assert.ok(t, a);
    assert.equal(t!.annotations?.readOnlyHint, false, a);
  }
  assert.equal(tools.find((t) => t.name === "client_campaigns")!.annotations?.destructiveHint, true);
  const brief = instructionsFor(ADMIN);
  assert.doesNotMatch(brief, /READ-ONLY/);
  assert.match(brief, /WITHOUT `confirm`/);
  assert.match(brief, /Never confirm on your own/);
  delete process.env.OS_MCP_ACTIONS;
});

test("switched on per action: only those named exist", () => {
  process.env.OS_MCP_ACTIONS = "inbox_snooze";
  assert.deepEqual(names(ADMIN).filter((n) => ACTIONS.includes(n)), ["inbox_snooze"]);
  delete process.env.OS_MCP_ACTIONS;
});

test("a named teammate: only the actions their switches open, only their read tools, and the scope note", async () => {
  process.env.OS_MCP_ACTIONS = ACTIONS.join(",");
  assert.deepEqual(names(INBOX_ONLY).filter((n) => ACTIONS.includes(n)), ["inbox_set_label", "inbox_snooze"]);
  assert.deepEqual(names(HEALTH_ONLY).filter((n) => ACTIONS.includes(n)), ["client_campaigns"]);
  assert.ok(!names(INBOX_ONLY).includes("commissions"), "admin-only read tools stay closed");
  assert.ok(!names(INBOX_ONLY).includes("billing_overview"));
  assert.match(instructionsFor(INBOX_ONLY), /not a workspace admin/);
  // Calling an action they don't hold is refused, not run.
  const r = (await runMcpTool("client_campaigns", { client: "Acme", action: "pause" }, INBOX_ONLY)) as { done: boolean; refused: string };
  assert.equal(r.done, false);
  assert.match(r.refused, /isn't available to you/);
  // And a read tool outside their switches is not there at all.
  await assert.rejects(runMcpTool("commissions", {}, INBOX_ONLY), /No tool named commissions/);
  delete process.env.OS_MCP_ACTIONS;
});

test("nobody is named for the connector until an admin decides (Eddy's rule: no new access by default)", () => {
  assert.deepEqual(NAMED_PAGES["claude-connector"], []);
  assert.equal(holdsPage("gabo075823532@gmail.com", "claude-connector"), false);
});
