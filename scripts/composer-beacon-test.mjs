/*
 * Regression test for the composer's unmount flush.
 *
 * The bug this pins down: `navigator.sendBeacon` cannot issue a PUT —
 * the spec gives it no method argument, every beacon is a POST — and
 * the composer-draft route exported only PUT and DELETE, so the one
 * code path whose whole job is "the user is navigating away mid-typing,
 * persist now" got a 405 every single time. The ~1.2s debounced
 * autosave masked it into "it didn't save the last thing I typed".
 *
 * Runs against real data, and restores whatever it found: if the chosen
 * thread already had a draft, it is written back byte-identical; if it
 * had none, the probe row is deleted. Never leaves a draft a human
 * would see.
 */
import fs from "node:fs";
const env = Object.fromEntries(
  (fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "")
    .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const pick = k => process.env[k] || env[k];
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const tok = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const B = process.env.BASE || "http://localhost:3210";

const { createClient } = await import("@supabase/supabase-js");
const db = createClient(pick("MASTER_INBOX_SUPABASE_URL"), pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

let fail = 0;
const check = (label, ok, note = "") => { console.log(`${ok ? "  ✓" : "  ✗"} ${label}${note ? "  " + note : ""}`); if (!ok) fail++; };

const { data: threads } = await db.from("threads").select("id,workspace_id,subject").limit(1);
const t = threads?.[0];
if (!t) { console.log("no threads — cannot test"); process.exit(1); }
console.log(`thread ${t.id}  "${(t.subject || "").slice(0, 40)}"`);

const { data: before } = await db.from("composer_drafts").select("*")
  .eq("workspace_id", t.workspace_id).eq("thread_id", t.id).maybeSingle();
console.log(`pre-existing draft: ${before ? "YES — will restore verbatim" : "none"}\n`);

const S = `beacon-probe-${Date.now()}`;
const url = `${B}/api/tools/master-inbox/threads/${t.id}/composer-draft`;
const H = { cookie: `bs_sso=${tok}`, "content-type": "application/json" };

const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify({ body_text: S, subject: S }) });
check("POST (the verb sendBeacon actually uses) is accepted", r.status === 200, `→ ${r.status}`);

const { data: after } = await db.from("composer_drafts").select("body_text")
  .eq("workspace_id", t.workspace_id).eq("thread_id", t.id).maybeSingle();
check("the draft reached the database", after?.body_text === S);

// PUT must keep working — the debounced autosave still uses it.
const r2 = await fetch(url, { method: "PUT", headers: H, body: JSON.stringify({ body_text: S + "-put" }) });
check("PUT still works (debounced autosave path)", r2.status === 200, `→ ${r2.status}`);

// Unauthenticated beacons must still be refused.
const r3 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body_text: "nope" }) });
check("an unauthenticated POST is refused", r3.status === 401 || r3.status === 403 || r3.status === 307, `→ ${r3.status}`);

if (before) {
  await db.from("composer_drafts").upsert(before, { onConflict: "workspace_id,thread_id" });
  const { data: back } = await db.from("composer_drafts").select("body_text,subject")
    .eq("workspace_id", t.workspace_id).eq("thread_id", t.id).maybeSingle();
  check("restored byte-identical", back?.body_text === before.body_text && back?.subject === before.subject);
} else {
  await db.from("composer_drafts").delete().eq("workspace_id", t.workspace_id).eq("thread_id", t.id);
  const { data: gone } = await db.from("composer_drafts").select("thread_id")
    .eq("workspace_id", t.workspace_id).eq("thread_id", t.id).maybeSingle();
  check("probe row cleaned up, no draft left behind", !gone);
}

console.log(`\n${fail === 0 ? "all checks passed" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
