import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { canSeeCrmPreview } from "./access.ts";

/*
 * The CRM redesign preview is for Owners only (ADMIN_EMAILS) — "only we should
 * be able to see this" — and must not be anywhere a client, or the rest of the
 * team, could come across it.
 */

const OWNERS = ["admin@outreachify.io"];

test("an Owner sees it, whatever the address's case", () => {
  assert.equal(canSeeCrmPreview("admin@outreachify.io", OWNERS), true);
  assert.equal(canSeeCrmPreview(" Admin@Outreachify.io ", OWNERS), true);
});

test("nobody else: not a marked admin, not an account manager, not a salesperson", () => {
  for (const email of ["eddy@brokerstaffer.com", "amy@brokerstaffer.com", "gabriel@brokerstaffer.com", "client@brokerage.com"]) {
    assert.equal(canSeeCrmPreview(email, OWNERS), false, email);
  }
});

test("fails closed: no Owners list, no session, no address — nobody", () => {
  assert.equal(canSeeCrmPreview("admin@outreachify.io", []), false);
  assert.equal(canSeeCrmPreview(null, OWNERS), false);
  assert.equal(canSeeCrmPreview("", OWNERS), false);
  assert.equal(canSeeCrmPreview("   ", OWNERS), false);
});

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}
const PREVIEW_FILES = [...filesUnder("src/app/crm-preview"), ...filesUnder("src/components/crm-preview"), ...filesUnder("src/lib/crm-preview")];

test("the page checks the Owner before it reads anything", () => {
  const src = read("src/app/crm-preview/page.tsx");
  const gate = src.indexOf("canSeeCrmPreview(");
  assert.ok(gate > 0, "the page calls the gate");
  assert.match(src.slice(gate, gate + 200), /notFound\(\)/, "and shows Not found to anyone else");
  for (const load of ["loadPipelineEntries(", "loadAgentEntries(", "loadDncEntries(", "loadTeamMembers(", ".from(\"clients\")"]) {
    const at = src.indexOf(load);
    assert.ok(at === -1 || at > gate, `${load} only after the gate`);
  }
});

test("read-only: nothing in the preview writes, posts or calls a server action", () => {
  assert.ok(PREVIEW_FILES.length >= 4, PREVIEW_FILES.join(", "));
  const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /method\s*:/, /["'](POST|PUT|PATCH|DELETE)["']/, /["']use server["']/, /formAction/, /navigator\.sendBeacon/];
  for (const f of PREVIEW_FILES) {
    const src = read(f);
    for (const w of WRITES) assert.doesNotMatch(src, w, `${f} matches ${w}`);
    // The one request the browser makes: the portal's own read-only conversation feed.
    for (const m of src.matchAll(/fetch\(\s*`([^`]*)`/g)) {
      assert.match(m[1], /^\/api\/tools\/master-inbox\/portal\/\$\{[^}]+\}\/conversation\/\$\{[^}]+\}$/, `${f}: ${m[1]}`);
    }
    assert.doesNotMatch(src, /fetch\(\s*["']/, `${f}: only the conversation feed is fetched`);
  }
});

test("not a product: no menu item, no Team access switch, no grant, nothing opened in the proxy", () => {
  for (const f of ["src/lib/workspace/nav.ts", "src/lib/identity/admin.ts", "src/lib/bs-auth.ts", "src/lib/workspace/tool-paths.ts", "src/proxy.ts", "src/components/screens/team-access.tsx"]) {
    assert.doesNotMatch(read(f), /crm-preview|crmPreview/i, f);
  }
});

test("the Follow Up Boss key never reaches the browser — only whether one is set", () => {
  const page = read("src/app/crm-preview/page.tsx");
  assert.doesNotMatch(page, /fubApiKey=|fub_api_key=\{/, "no key passed as a prop");
  for (const f of PREVIEW_FILES.filter((f) => f.startsWith("src/components/"))) {
    assert.doesNotMatch(read(f), /fub_api_key/, f);
  }
});
