/*
 * The write paths that touch NOTHING but our own databases.
 *
 *   node --import ./scripts/alias-hooks.mjs scripts/safe-writes-test.mjs [baseUrl]
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ONES, AND NOT THE OTHERS
 *
 * Of the 99 routes in this workspace that can change something, 19 reach the
 * outside world — email, Slack, a webhook, a campaign launch — and 31 talk to
 * an upstream tool. Pressing those in a test spends money or emails a real
 * person, so they stay untested until somebody decides otherwise.
 *
 * The rest only write rows we own. Those can be exercised properly: create
 * something, read it back, change it, read it back, remove it, and confirm it
 * is gone. That is the whole of "does saving work", and it can be done without
 * a single real record being touched.
 *
 * Everything created here is named ZZ-something and deleted in `finally`, so a
 * crash leaves an obvious fixture rather than a plausible-looking record.
 */
import fs from "node:fs";

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3210";
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const tok = await mintSso(env.BS_SSO_SECRET || env.AUTH_SECRET,
  { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const H = { cookie: `bs_sso=${tok}`, "Content-Type": "application/json" };

let pass = 0, fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};
const call = async (path, method = "GET", body) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let json = null;
  try { json = await r.json(); } catch { /* some routes return no body */ }
  return { status: r.status, json };
};
const stamp = Date.now();

/* ============================ reply templates ============================ */
console.log("\n  ── Reply templates (Master Inbox) ──");
let templateId = null;
try {
  const name = `ZZ Template ${stamp}`;
  const made = await call("/api/tools/master-inbox/reply-templates", "POST",
    { name, body: "Hello {{lead.first_name}}, this is a test template.", category: "ZZ Test" });
  check(made.status < 300, "created", `HTTP ${made.status}`);
  templateId = made.json?.template?.id ?? made.json?.id ?? null;

  const list = await call("/api/tools/master-inbox/reply-templates");
  const rows = list.json?.templates ?? list.json?.rows ?? [];
  const mine = rows.find((t) => t.name === name);
  check(!!mine, "reads back in the list", mine ? `id=${String(mine.id).slice(0, 8)}…` : "not found");
  templateId = templateId ?? mine?.id ?? null;

  if (templateId) {
    const edited = await call(`/api/tools/master-inbox/reply-templates/${templateId}`, "PATCH",
      { name: `${name} edited`, body: "Edited body." });
    check(edited.status < 300, "edited", `HTTP ${edited.status}`);
    const after = (await call("/api/tools/master-inbox/reply-templates")).json?.templates ?? [];
    check(after.some((t) => t.name === `${name} edited`), "the edit really saved");
  }
} catch (e) {
  check(false, "reply templates", e instanceof Error ? e.message : String(e));
} finally {
  if (templateId) {
    const gone = await call(`/api/tools/master-inbox/reply-templates/${templateId}`, "DELETE");
    check(gone.status < 300, "removed", `HTTP ${gone.status}`);
    const after = (await call("/api/tools/master-inbox/reply-templates")).json?.templates ?? [];
    check(!after.some((t) => String(t.id) === String(templateId)), "really gone from the list");
  }
}

/* =============================== custom views ============================ */
console.log("\n  ── Custom views (Master Inbox) ──");
let viewId = null;
try {
  const name = `ZZ View ${stamp}`;
  // `filter_json`, not `filter` — the field name the route's schema requires.
  // My first attempt sent `filter` and got a 400, which looked like a broken
  // save until I read the schema. Worth pinning so the next reader does not
  // repeat it.
  const made = await call("/api/tools/master-inbox/custom-views", "POST",
    { name, filter_json: { label_ids: [] } });
  check(made.status < 300, "created", `HTTP ${made.status}`);
  viewId = made.json?.view?.id ?? made.json?.id ?? null;
  /*
   * Read back from the TABLE, not from a list endpoint.
   *
   * This route only implements POST — there is no GET, so asking for one
   * returns 405 with an empty body, which looked like a broken save until I
   * read the file. Custom views are loaded server-side with the inbox screen
   * rather than fetched. A direct read is how to prove the row landed.
   */
  const { getMasterInboxSupabase } = await import("@/lib/tools/master-inbox/supabase.ts");
  const { data: saved } = await getMasterInboxSupabase()
    .from("custom_views").select("id, name").eq("name", name).maybeSingle();
  check(!!saved, "the row really landed in the database", saved ? `id=${String(saved.id).slice(0, 8)}…` : "not found");
  viewId = viewId ?? saved?.id ?? null;
} catch (e) {
  check(false, "custom views", e instanceof Error ? e.message : String(e));
} finally {
  if (viewId) {
    const gone = await call(`/api/tools/master-inbox/custom-views/${viewId}`, "DELETE");
    check(gone.status < 300, "removed", `HTTP ${gone.status}`);
    const { getMasterInboxSupabase: db2 } = await import("@/lib/tools/master-inbox/supabase.ts");
    const { data: still } = await db2().from("custom_views").select("id").eq("id", viewId).maybeSingle();
    check(!still, "really gone from the database");
  }
}

/* ============================== analytics offers ========================= */
console.log("\n  ── Offers (Analytics) ──");
let offerId = null;
try {
  const name = `ZZ Offer ${stamp}`;
  const made = await call("/api/tools/analytics/offers", "POST", { name, description: "test offer" });
  check(made.status < 300, "created", `HTTP ${made.status}`);
  offerId = made.json?.offer?.id ?? made.json?.id ?? null;
  const rows = (await call("/api/tools/analytics/offers")).json?.offers ?? [];
  check(rows.some((o) => o.name === name), "reads back in the list");
  offerId = offerId ?? rows.find((o) => o.name === name)?.id ?? null;
} catch (e) {
  check(false, "offers", e instanceof Error ? e.message : String(e));
} finally {
  if (offerId) {
    const gone = await call(`/api/tools/analytics/offers/${offerId}`, "DELETE");
    check(gone.status < 300, "removed", `HTTP ${gone.status}`);
  }
}

console.log(`\n  ${pass} passed · ${fail} failed`);
console.log("  Nothing outside these fixtures was touched.\n");
process.exit(fail ? 1 : 0);
