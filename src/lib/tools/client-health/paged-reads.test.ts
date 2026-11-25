/*
 * Guard (Nov 2026): every read of a Client Health table that can pass Supabase's 1,000-rows-per-request cap is paged
 * (read-all.ts, or .range in a loop) or narrowed to specific rows (.eq / .in / .limit / single). bison_campaigns passed
 * 1,000 unnoticed and five reads silently saw an arbitrary 1,000 (see read-all.ts). Scans the Client Health code and
 * every file that opens its database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const files: string[] = [];
(function walk(d: string) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { if (f !== "node_modules") walk(p); }
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) {
      const src = fs.readFileSync(p, "utf8");
      if (p.includes(`${path.sep}tools${path.sep}client-health${path.sep}`) || /client-health\/supabase/.test(src)) files.push(p);
    }
  }
})(path.join(ROOT, "src"));

const GROWING = /from\((["'])(bison_campaigns|instantly_campaigns|weekly_metrics|sync_runs|campaign_toggle_log)\1\)|from\(table\)/;
const NARROW = /\.range\(|readAll|\.in\(|\.eq\(|\.limit\(|\.single\(|\.maybeSingle\(|head:\s*true/;

test("no unpaged read of a growing Client Health table", () => {
  assert.ok(files.length > 30, `scanned ${files.length} files`);
  const bad: string[] = [];
  for (const f of files) {
    for (const stmt of fs.readFileSync(f, "utf8").split(/;\s*\n/)) {
      if (GROWING.test(stmt) && /\.select\(/.test(stmt) && !NARROW.test(stmt)) {
        bad.push(`${path.relative(ROOT, f)}: ${stmt.replace(/\s+/g, " ").trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
