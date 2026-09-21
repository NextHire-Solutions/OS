import assert from "node:assert/strict";
import { test } from "node:test";

import { NotAnOsTableError, OS_TABLES } from "./os-tables.ts";

/*
 * The guard that stands between the OS and 47 live portal tokens.
 *
 * `os-db.ts` holds a service-role connection to Master Inbox's database. That
 * connection could write to `clients`, `threads`, or any of the other 40
 * tables, and the only thing stopping it is the allowlist. So the allowlist
 * gets a test: not because the code is complicated, but because the cost of it
 * quietly widening is a customer's portal.
 *
 * `osTable()` itself is not called here — it opens a real connection. What is
 * pinned is the list, which is the part that could drift.
 */

test("the allowlist contains exactly the OS tables", () => {
  assert.deepEqual([...OS_TABLES], [
    "os_clients", "os_client_onboarding", "os_tool_grants", "os_users",
    "os_reply_examples", "os_agent_knowledge", "os_reply_feedback", "os_knowledge_proposals",
    "os_client_aliases", "os_assistant_chats", "os_assistant_messages",
  ]);
});

/*
 * Every entry is os_-prefixed, which is the rule that makes the list reviewable
 * at a glance: an entry without the prefix is a Master Inbox table and does not
 * belong here, however it got added.
 */
test("every allowed table is os_-prefixed", () => {
  for (const table of OS_TABLES) {
    assert.ok(table.startsWith("os_"), `${table} is not an OS table`);
  }
});

test("no Master Inbox table is reachable through the OS client", () => {
  // The tables whose contents are externally visible or trigger-bearing.
  const forbidden = [
    "clients",            // holds portal_token — a live, login-free URL
    "threads",
    "messages",
    "client_pipeline_entries",
    "client_agents",
    "client_team_members",
    "client_dnc_entries",
    "lists",
    "reply_templates",
    "workspaces",
  ];
  for (const table of forbidden) {
    assert.equal(
      (OS_TABLES as readonly string[]).includes(table),
      false,
      `${table} must never be reachable through the OS client`,
    );
  }
});

test("the error names the table and points at the rule", () => {
  const err = new NotAnOsTableError("clients");
  assert.match(err.message, /clients/);
  assert.match(err.message, /os_clients and os_client_onboarding/);
  assert.equal(err.name, "NotAnOsTableError");
});
