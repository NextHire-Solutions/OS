#!/usr/bin/env node
/*
 * Inbox assignment on Instantly, through the OS route, against a DISPOSABLE
 * campaign. The tool's own `scripts/verify-instantly-inboxes.mjs`, pointed at
 * `/api/tools/analytics/...` and carrying an OS `bs_sso` token instead of the
 * standalone's `bsa_session`.
 *
 * The assignment logic is byte-identical between the two apps, so this exists
 * to prove the OS ROUTE reaches it — auth, team id, namespaced path — not to
 * re-test the logic.
 *
 * Instantly has two independent ways to give a campaign its inboxes:
 *
 *   email_list      a frozen array of addresses
 *   email_tag_list  the POOL assignment — live, and what this estate uses
 *
 * `email_tag_list` is a whole-array replace, so writing only the tag being
 * assigned would DETACH every other pool on the campaign, silently, with a 200.
 * The assertions are therefore about what SURVIVES a change, not just what
 * lands.
 *
 * OPT-IN. The campaign is created here, never activated, and deleted at the end.
 *   BASE=http://localhost:3222 node scripts/verify-instantly-inboxes.mjs
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).replace(/^["']|["']$/g, "")]),
);
const APP = process.env.BASE ?? "http://localhost:3000";
const KEY = env.ANALYTICS_INSTANTLY_API_KEY;
const IB = env.ANALYTICS_INSTANTLY_BASE_URL || "https://api.instantly.ai";

/*
 * An OS SSO token, minted exactly as `mintSso` does: base64url(payload) plus an
 * HMAC-SHA256 hex signature over that same string. `ver: 0` because the route
 * only reads the session's email.
 */
const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const mint = async () => {
  const email = (env.AUTH_USERS ?? "").split(/[\n,]+/)[0].split(":")[0].trim();
  if (!email) throw new Error("no AUTH_USERS entry to mint a session for");
  const now = Date.now();
  const body = b64url(JSON.stringify({
    email: email.toLowerCase(),
    grants: ["inbox", "clients", "analytics", "search", "onboarding"],
    ver: 0,
    iat: now,
    exp: now + 3_600_000,
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${body}.${sig}`;
};
const TOKEN = process.env.SMOKE_TOKEN ?? (await mint());

const inst = async (m, p, b) => {
  const r = await fetch(`${IB}${p}`, { method: m, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, ok: r.ok, json: j };
};
const API = `${APP}/api/tools/analytics/campaigns/inboxes`;
const assign = async (targets, tag, action) => {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `bs_sso=${TOKEN}` },
    body: JSON.stringify({ targets, tag, action, confirm: true }),
  });
  return { status: r.status, body: await r.json() };
};
const tagList = async (id) => (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_tag_list ?? [];
const mailList = async (id) => (await inst("GET", `/api/v2/campaigns/${id}`)).json?.email_list ?? [];

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ok    ${n}${d ? " — " + d : ""}`); };
const no = (n, w) => { fail++; console.log(`  FAIL  ${n} — ${w}`); };

const sched = { schedules: [{ name: "p", timing: { from: "09:00", to: "17:00" }, days: { 1: true }, timezone: "America/Detroit" }] };
let id = null;
try {
  const res = await fetch(`${API}?platform=instantly`, { headers: { cookie: `bs_sso=${TOKEN}` } });
  if (res.status === 401) throw new Error("OS route rejected the minted session (401)");
  const pools = await res.json();
  const sorted = (pools.tags ?? []).slice().sort((a, b) => a.inboxes - b.inboxes);
  const small = sorted[0], other = sorted[1];
  if (!small) throw new Error("no Instantly pools returned");
  ok("the OS route authenticates and lists pools", (pools.tags ?? []).map((t) => `${t.tag}(${t.inboxes})`).join(", "));

  const custom = (await inst("GET", "/api/v2/custom-tags?limit=100")).json?.items ?? [];
  const idFor = (label) => custom.find((t) => (t.label ?? t.name ?? "").trim().toLowerCase() === label.toLowerCase())?.id;
  const smallId = idFor(small.tag), otherId = other ? idFor(other.tag) : null;

  id = (await inst("POST", "/api/v2/campaigns", { name: "ZZZ-OS-INBOX-TEST", campaign_schedule: sched })).json?.id;
  console.log(`  campaign: ${id}\n`);
  const targets = [{ platform: "instantly", id }];

  const accounts = await inst("GET", "/api/v2/accounts?limit=1");
  const keeper = accounts.json?.items?.[0]?.email;
  await inst("PATCH", `/api/v2/campaigns/${id}`, { email_list: [keeper] });
  if (otherId) await inst("PATCH", `/api/v2/campaigns/${id}`, { email_tag_list: [otherId] });

  const a = await assign(targets, small.tag, "attach");
  const ar = a.body?.results?.[0];
  if (ar?.ok) ok("attach a pool", `applied=${ar.applied} (pool of ${small.inboxes})`);
  else no("attach a pool", JSON.stringify(a.body).slice(0, 200));

  const after = await tagList(id);
  if (after.includes(smallId)) ok("the pool landed as a TAG", `email_tag_list=${after.length}`);
  else no("the pool landed as a TAG", `${smallId} not in ${JSON.stringify(after)}`);

  if (!otherId) ok("second-pool survival", "skipped — only one pool exists");
  else if (after.includes(otherId)) ok("THE OTHER POOL SURVIVED", "both tags present");
  else no("THE OTHER POOL SURVIVED", `${other.tag} was detached`);

  const pinned = await mailList(id);
  if (pinned.includes(keeper)) ok("THE PINNED ADDRESS SURVIVED", `email_list untouched (${pinned.length})`);
  else no("THE PINNED ADDRESS SURVIVED", `${keeper} was lost`);

  if (ar?.applied === small.inboxes) ok("applied reports the pool size", `${ar.applied}`);
  else no("applied reports the pool size", `applied=${ar?.applied}, pool=${small.inboxes}`);

  const again = await assign(targets, small.tag, "attach");
  const gr = again.body?.results?.[0];
  const afterAgain = await tagList(id);
  if (gr?.applied === 0 && afterAgain.length === after.length) ok("re-assigning is a no-op", "applied=0, no duplicate tag");
  else no("re-assigning is a no-op", `applied=${gr?.applied}, ${after.length} → ${afterAgain.length}`);

  const rm = await assign(targets, small.tag, "remove");
  const rr = rm.body?.results?.[0];
  const afterRemove = await tagList(id);
  const keptOther = !otherId || afterRemove.includes(otherId);
  if (rr?.ok && !afterRemove.includes(smallId) && keptOther) ok("remove takes the pool off and keeps the rest", `${afterRemove.length} tag(s) left`);
  else no("remove takes the pool off and keeps the rest", `applied=${rr?.applied}, left=${JSON.stringify(afterRemove)}`);

  const ebOnly = "Zapmail";
  if (!custom.some((t) => (t.label ?? t.name ?? "").trim().toLowerCase() === ebOnly.toLowerCase())) {
    const miss = await assign(targets, ebOnly, "attach");
    const mr = miss.body?.results?.[0];
    if (mr && !mr.ok && /no instantly inbox tag/i.test(mr.error ?? "")) ok("an EmailBison-only pool is refused, not silently skipped", mr.error);
    else no("an EmailBison-only pool is refused, not silently skipped", JSON.stringify(miss.body).slice(0, 200));
  } else {
    ok("EmailBison-only pool check", `skipped — "${ebOnly}" also exists on Instantly`);
  }
} catch (e) {
  no("unexpected", e.message);
} finally {
  if (id) {
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      if (i) await new Promise((r) => setTimeout(r, 8000));
      const d = await inst("DELETE", `/api/v2/campaigns/${id}`);
      gone = d.ok || d.status === 404;
    }
    console.log(`\n  cleanup: ${gone ? "removed" : "STILL EXISTS — remove by hand"}`);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
