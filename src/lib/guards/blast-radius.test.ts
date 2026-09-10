/*
 * The OS must not write to another tool's database.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS A TEST RATHER THAN A CONVENTION
 *
 * Four tools stay deployed and in use: Client Health, Campaign Analytics,
 * Agent Search and Onboarding. The OS reads them so it can show their data in
 * one place. It must never write to them — a bad write would corrupt a live
 * product that people are using, from a codebase whose authors were not
 * thinking about that product.
 *
 * Master Inbox is the deliberate exception. The OS *is* the staff inbox now;
 * the live service is kept only for client portals, provider webhooks and
 * crons. So writes there are the feature, not a violation.
 *
 * This is a test and not a code review note because the failure is invisible.
 * Adding `.update()` to a Client Health route would typecheck, build, deploy
 * and work — and quietly become a second writer to a database with exactly one
 * expected writer. Nothing would look wrong until data did.
 *
 *   node --test src/lib/guards/blast-radius.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Tools whose databases the OS may only read. */
const READ_ONLY_TOOLS = ["client-health", "analytics", "agent-search", "onboarding"];

/** PostgREST's mutating verbs. `select` is absent on purpose. */
const WRITE_CALL = /\.(insert|update|upsert|delete)\s*\(/;

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Strips comments, so prose describing a write is not mistaken for one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

for (const tool of READ_ONLY_TOOLS) {
  test(`the OS never writes to ${tool}'s database`, () => {
    const offenders: string[] = [];

    for (const dir of [`src/lib/tools/${tool}`, `src/app/api/tools/${tool}`]) {
      for (const file of sourceFiles(dir)) {
        const lines = code(fs.readFileSync(file, "utf8")).split("\n");
        lines.forEach((line, i) => {
          if (WRITE_CALL.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `${tool} is a live deployed product and the OS may only read it.\n` +
        `Found ${offenders.length} write call(s):\n  ${offenders.join("\n  ")}\n\n` +
        `If a write is genuinely required, it belongs in that tool's own codebase ` +
        `behind its own API — not here.`,
    );
  });
}

test("master-inbox is the one tool the OS may write to", () => {
  // Stated as a test so the exception is explicit rather than an absence.
  // If this ever finds nothing, the inbox has stopped working, not started
  // being safe.
  const writes = ["src/lib/tools/master-inbox", "src/app/api/tools/master-inbox"]
    .flatMap(sourceFiles)
    .filter((f) => WRITE_CALL.test(code(fs.readFileSync(f, "utf8"))));

  assert.ok(
    writes.length > 0,
    "Expected Master Inbox to contain writes — the OS is the staff inbox now.",
  );
});
