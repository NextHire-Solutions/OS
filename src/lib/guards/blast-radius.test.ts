/*
 * No write may be unscoped.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RULE REPLACED THE OLD ONE
 *
 * This file used to assert that the OS only READ the other tools' databases,
 * with Master Inbox as the single exception. That was right while the OS was a
 * window onto five live products.
 *
 * It is no longer the architecture. The OS is replacing every tool — Client
 * Health, Agent Search, Onboarding and Analytics as well as Master Inbox — so
 * it reads and writes all of them, and the old rule would only block correct
 * work. Deleting a stale test is better than keeping one that fails for the
 * wrong reason, because a suite people learn to override protects nothing.
 *
 * What is still worth guarding is the shape of a write. PostgREST applies an
 * `.update()` or `.delete()` with no filter to EVERY ROW IN THE TABLE. There is
 * no confirmation, no transaction to roll back, and the first sign of trouble
 * is a customer noticing their data is gone. That mistake is one forgotten
 * `.eq()` away in any of the ~200 write call sites now in this repo, and it is
 * invisible in review because the code looks ordinary.
 *
 *   node --test src/lib/guards/blast-radius.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Every tool the OS now owns. */
const TOOLS = ["master-inbox", "client-health", "agent-search", "onboarding", "analytics"];

/** The filters that narrow a PostgREST write to specific rows. */
const SCOPES = /\.(eq|in|match|filter|neq|gt|gte|lt|lte|like|ilike|is|or|contains|overlaps|textSearch)\s*\(/;

/** `upsert` and `insert` are inherently scoped — they carry their own rows. */
const UNSAFE_VERB = /\.(update|delete)\s*\(/;

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

/** Comments stripped, so prose describing a delete is not read as one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/*
 * A write and its filters are usually on separate lines:
 *
 *     await db.from("x")
 *       .update({ ... })
 *       .eq("id", id);
 *
 * so a line-by-line check would flag every correct write. This reads the
 * statement — from the verb to the terminating semicolon — and asks whether a
 * scope appears anywhere inside it.
 */
function unscopedWrites(source: string): string[] {
  const text = code(source);
  const found: string[] = [];

  /*
   * Anchor on `.from("table")`, not on the verb.
   *
   * The first version matched any `.update(` or `.delete(` and flagged four
   * `Map.delete(key)` calls in a TTL cache — JavaScript collection methods that
   * have nothing to do with a database. Only a PostgREST chain begins with
   * `.from(...)`, so that is the anchor; the verb and its filters are then read
   * from the same statement.
   */
  const re = /\.from\s*\(\s*["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let i = m.index, depth = 0, end = -1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (c === ";" && depth <= 0) { end = i; break; }
    }
    const statement = text.slice(m.index, end === -1 ? text.length : end);
    if (!UNSAFE_VERB.test(statement)) continue;
    if (SCOPES.test(statement)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    found.push(`line ${line}: ${statement.trim().replace(/\s+/g, " ").slice(0, 110)}`);
  }
  return found;
}

for (const tool of TOOLS) {
  test(`every ${tool} write is scoped to specific rows`, () => {
    const offenders: string[] = [];
    for (const dir of [`src/lib/tools/${tool}`, `src/app/api/tools/${tool}`]) {
      for (const file of sourceFiles(dir)) {
        for (const hit of unscopedWrites(fs.readFileSync(file, "utf8"))) {
          offenders.push(`${file} ${hit}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `An .update() or .delete() with no filter changes EVERY ROW in the table.\n` +
        `Found ${offenders.length} in ${tool}:\n  ${offenders.join("\n  ")}\n\n` +
        `Add a scope — .eq("id", id) or .in("id", ids) — or, if the whole table\n` +
        `really is the target, say so in a comment on the same statement.`,
    );
  });
}

test("the OS actually owns these tools now", () => {
  /*
   * Stated as a test so the architecture is asserted rather than assumed. If
   * this ever finds no writes, the OS has become a read-only viewer again and
   * the rule above is guarding nothing.
   */
  const writes = TOOLS.flatMap((t) =>
    [`src/lib/tools/${t}`, `src/app/api/tools/${t}`]
      .flatMap(sourceFiles)
      .filter((f) => UNSAFE_VERB.test(code(fs.readFileSync(f, "utf8")))),
  );
  assert.ok(writes.length > 0, "Expected the OS to write to the tools it now owns.");
});
