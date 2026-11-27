/*
 * The assistant for someone who isn't an admin (18 Nov, the user: "give access to the AI assistant on the OS to Gabriel
 * Castillo" — "Only what he can see"): who may use it, which tools each person gets, and the turn itself refusing a
 * tool outside them. Run with node --experimental-test-module-mocks --import ./scripts/alias-hooks.mjs --test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_TOOLS, type SsoSession } from "../../bs-auth.ts";
import { canUseAssistant } from "./access.ts";
import { handlersFor, runTurn, TOOL_SCHEMA, toolSchemaFor, withoutClientCounts, withoutScrapes, type ModelFn, type ModelMessage } from "./engine.ts";
import { allowedToolNames, scopeNote, TOOL_NEEDS, toolAllowed, type AssistantViewer } from "./viewer.ts";

const GABRIEL = "gabo075823532@gmail.com";
const gabriel: AssistantViewer = { email: GABRIEL, admin: false, grants: ["inbox", "portals", "clients", "analytics", "roster", "campaigns", "inboxes"], billing: false };
const admin: AssistantViewer = { email: "admin@outreachify.io", admin: true, grants: [], billing: true };
const NAMES = TOOL_SCHEMA.map((t) => t.function.name);
const session = (email: string, grants: string[] = []): SsoSession => ({ email, grants, ver: 1, iat: 0, exp: Date.now() + 60_000 }) as unknown as SsoSession;

test("who may use it: admins, and Gabriel Castillo by name — nobody else, whatever their switches", () => {
  assert.equal(canUseAssistant(session("admin@example.com"), true), true);
  assert.equal(canUseAssistant(session(GABRIEL, gabriel.grants as string[]), false), true);
  assert.equal(canUseAssistant(session(" Gabo075823532@Gmail.com "), false), true);
  for (const email of ["amy@brokerstaffer.com", "eddy.b@brokerstaffer.com", "gabo075823532@gmail.co", "gabriel@brokerstaffer.com"]) {
    assert.equal(canUseAssistant(session(email, [...ALL_TOOLS]), false), false, email);
  }
  assert.equal(canUseAssistant(null, false), false);
});

test("every tool has a rule, and every rule is a tool — a new tool can't slip through unruled", () => {
  assert.deepEqual([...NAMES].sort(), Object.keys(TOOL_NEEDS).sort());
});

test("an admin keeps every tool, exactly as before", () => {
  assert.deepEqual(allowedToolNames(NAMES, admin), NAMES);
  assert.equal(toolSchemaFor(admin), TOOL_SCHEMA);
});

test("Gabriel: the tools for his switches — clients, Client Health, campaigns, inboxes, Master Inbox, portals; nothing else", () => {
  const got = allowedToolNames(NAMES, gabriel).sort();
  assert.deepEqual(got, [
    "attribution", "billing_cycles", "campaign_copy", "campaign_detail", "campaign_kpis", "campaigns_for_client",
    "client_commercials", "client_introduction", "client_overview", "client_portals", "client_rankings", "client_record",
    "client_reply_rates", "client_report", "client_success", "find_client", "find_lead", "inbox_activity", "inbox_deliverability",
    "infrastructure_health", "list_clients", "outcomes", "portal_pipeline", "positive_replies", "profile_completeness", "recent_introductions",
    "recent_replies", "reminders", "reply_templates", "search_conversations", "send_schedule", "sending_volume", "workspace_home",
  ]);
  for (const t of ["client_billing", "billing_overview", "commissions", "team", "notifications", "data_consistency", "reply_agent_status", "business_performance", "onboarding_records", "scrape_activity", "agent_database", "find_agent", "search_agents", "agent_places", "mls_coverage"]) {
    assert.equal(toolAllowed(t, gabriel), false, t);
  }
  assert.deepEqual(toolSchemaFor(gabriel).map((t) => t.function.name).sort(), got, "the model is offered exactly these");
});

test("money is the Billing tab's people; admin-only tools stay admin-only even with every switch and billing", () => {
  const everything: AssistantViewer = { email: "someone@brokerstaffer.com", admin: false, grants: [...ALL_TOOLS], billing: true };
  assert.equal(toolAllowed("client_billing", everything), true);
  assert.equal(toolAllowed("billing_overview", everything), true);
  assert.equal(toolAllowed("client_billing", { ...everything, billing: false }), false);
  for (const t of ["commissions", "team", "notifications", "data_consistency", "reply_agent_status"]) assert.equal(toolAllowed(t, everything), false, t);
  assert.equal(toolAllowed("no_such_tool", everything), false, "an unknown tool is admins only");
  assert.equal(toolAllowed("constructor", everything), false, "not fooled by an object's own names");
});

test("a tool that reads several products needs all of them: one switch missing, refused", () => {
  for (const g of ["roster", "inbox", "portals", "analytics", "clients"]) {
    assert.equal(toolAllowed("client_report", { ...gabriel, grants: gabriel.grants.filter((x) => x !== g) }), false, `client_report without ${g}`);
  }
  for (const g of ["inbox", "analytics", "clients", "portals"]) {
    assert.equal(toolAllowed("client_overview", { ...gabriel, grants: gabriel.grants.filter((x) => x !== g) }), false, `client_overview without ${g}`);
  }
});

test("the model is told what this person can't see — and nothing when an admin asks", () => {
  assert.equal(scopeNote(admin), null);
  const note = scopeNote(gabriel)!;
  for (const w of ["billing", "commissions", "the agent database", "onboarding", "never estimate"]) assert.match(note, new RegExp(w), w);
  assert.doesNotMatch(scopeNote({ ...gabriel, billing: true })!, /billing, invoices/, "a Billing-tab person isn't told billing is closed");
  assert.doesNotMatch(scopeNote({ ...gabriel, grants: [...gabriel.grants, "search"] })!, /agent database/);
});

test("client_overview without Agent Search: its scrape figures are left out and it says so, never zero", () => {
  const out = withoutScrapes({ client: { id: "c", name: "Keyes" }, scraping: { agents: 120, lastScrapeAt: "x" }, inbox: { threads: 3 } }) as Record<string, unknown>;
  assert.equal("scraping" in out, false);
  assert.match(String(out.notShown), /not switched on for this person.*not zero/);
  assert.deepEqual(out.inbox, { threads: 3 });
  assert.deepEqual(withoutScrapes({ error: "No client" }), { error: "No client" }, "an error passes through");
});

/* ------------------------------------------------------------------ the turn --- */

function scripted(replies: Array<Awaited<ReturnType<ModelFn>>>) {
  const seen: ModelMessage[][] = [];
  let i = 0;
  const fn: ModelFn = async (messages) => { seen.push(JSON.parse(JSON.stringify(messages)) as ModelMessage[]); return replies[Math.min(i++, replies.length - 1)]; };
  return { fn, seen };
}
const answer = (content: string) => ({ content, toolCalls: [], tokensPrompt: 1, tokensCompletion: 1 });
const calls = (name: string, args: unknown) => ({ content: null, toolCalls: [{ id: "c1", name, arguments: JSON.stringify(args) }], tokensPrompt: 1, tokensCompletion: 1 });

test("a tool outside Gabriel's is refused in the turn itself, even if the model asks for it — nothing is read", async () => {
  for (const name of ["client_billing", "billing_overview", "commissions", "team", "search_agents", "data_consistency"]) {
    const { fn, seen } = scripted([calls(name, { client: "Homebase" }), answer("Not available to you.")]);
    const r = await runTurn([], "How much does Homebase pay us?", fn, gabriel);
    assert.equal(r.toolCalls.length, 1, name);
    assert.match(String((r.toolCalls[0].result as { error?: string }).error), /isn't available to this person/, name);
    assert.match(String(seen[0][0].content), /not a workspace admin/, `${name}: the system prompt carries the note`);
  }
});

test("an admin's turn is unchanged: no note, the tool is not refused", async () => {
  const { fn, seen } = scripted([answer("Hi.")]);
  await runTurn([], "hi", fn, admin);
  assert.doesNotMatch(String(seen[0][0].content), /not a workspace admin/);
});

test("Home's client counts are Performance's: left out for someone without that switch, kept for an admin", () => {
  const out = withoutClientCounts({ overview: [1], clients: { active: 20, churnedThisMonth: 2 }, tools: [] }) as Record<string, unknown>;
  assert.equal("clients" in out, false);
  assert.match(String(out.notShown), /Performance.*not zero/);
  assert.deepEqual(out.overview, [1]);
  assert.notEqual(handlersFor(gabriel).workspace_home, handlersFor(admin).workspace_home, "Gabriel's Home tool is the trimmed one");
  assert.equal(handlersFor({ ...gabriel, grants: [...gabriel.grants, "performance"] }).workspace_home, handlersFor(admin).workspace_home);
});
