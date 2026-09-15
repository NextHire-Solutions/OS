/*
 * Team access, end to end on the deployed site.
 *
 *   1. The screen: Invite enabled, the Owner's switches locked "On".
 *   2. The dialog opens and refuses an empty form.
 *   3. Invite a test teammate through the API → a temporary password comes back.
 *   4. That person can SIGN IN with it and their token carries exactly the
 *      tools chosen — the only proof that matters.
 *   5. Owner grants cannot be changed (409).
 *   6. Deactivate → sign-in refused. The test row stays deactivated, never
 *      deleted (there is no delete; people are deactivated).
 *
 * Writes: one os_users row (test-invite@brokerstaffer.com) and its grants row.
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const CDP = `http://localhost:${process.env.PORT || 9590}`;
const TEST_EMAIL = "test-invite@brokerstaffer.com";

const { mintSso, verifySso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const SECRET = pick("BS_SSO_SECRET") || pick("AUTH_SECRET");
const admin = await mintSso(SECRET, { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const H = { cookie: `bs_sso=${admin}`, "content-type": "application/json" };

let passed = 0, failed = 0; const fails = [];
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`); ok ? passed++ : (failed++, fails.push(name)); };
const api = async (method, path, body, headers = H) => { const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j, headers: r.headers }; };

console.log(`\nTEAM ACCESS\n${"=".repeat(72)}\n`);

/* ---- 1–2. the screen, in a real browser ---- */
const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const waiting = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (m, p = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Network.enable"); await send("Network.setCookie", { name: "bs_sso", value: admin, domain: "os.brokerstaffer.com", path: "/", secure: true });
await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE + "/team" });
for (let i = 0; i < 50; i++) { if (/Invite teammate/.test(await ev("document.body.innerText") || "")) break; await sleep(200); }
await sleep(800);
const screen = JSON.parse(await ev(`(() => {
  const btn=[...document.querySelectorAll('button')].find(b=>/invite teammate/i.test(b.innerText||''));
  const owner=[...document.querySelectorAll('button[aria-label*="admin@outreachify.io"]')];
  return JSON.stringify({ inviteEnabled: !!btn && !btn.disabled, ownerSwitches: owner.length, ownerLocked: owner.length>0 && owner.every(b=>b.disabled && b.getAttribute('aria-pressed')==='true'), note: (document.body.innerText.match(/every tool, always/)||[])[0]||null });
})()`));
check("Invite teammate is enabled", screen.inviteEnabled);
check("Owner's five switches are locked On", screen.ownerLocked, `${screen.ownerSwitches} switches, note=${screen.note}`);
await ev(`[...document.querySelectorAll('button')].find(b=>/invite teammate/i.test(b.innerText||''))?.click()`); await sleep(900);
const dlg = JSON.parse(await ev(`(() => { const d=document.querySelector('[data-modal-dialog]'); if(!d) return '{"open":false}'; const inv=[...d.querySelectorAll('button')].find(b=>/^invite$/i.test((b.innerText||'').trim())); return JSON.stringify({open:true, fields: d.querySelectorAll('input').length, tools: d.querySelectorAll('[role=switch]').length, inviteDisabledWhenEmpty: !!inv && inv.disabled}); })()`));
check("dialog opens with name, email and five tool switches", dlg.open && dlg.fields === 2 && dlg.tools === 5, JSON.stringify(dlg));
check("Invite is disabled until the form is valid", dlg.inviteDisabledWhenEmpty);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" }); await sleep(400);
check("Escape closes the dialog", !(await ev(`!!document.querySelector('[data-modal-dialog]')`)));
ws.close();

/* ---- 3–6. the API and a real sign-in ---- */
// leave no trace from an earlier run: if the test person exists, that is fine — we deactivate at the end either way.
const bad = await api("POST", "/api/admin/users", { email: "not-an-email", name: "x", grants: ["inbox"] });
check("invite rejects a bad address", bad.status === 400, `HTTP ${bad.status}`);
const none = await api("POST", "/api/admin/users", { email: "someone@brokerstaffer.com", name: "x", grants: [] });
check("invite rejects a person with no tools", none.status === 400, `HTTP ${none.status}`);

let temp = null;
const inv = await api("POST", "/api/admin/users", { email: TEST_EMAIL, name: "Test Invite", grants: ["clients", "search"] });
if (inv.status === 409 && /already/.test(inv.body?.error || "")) {
  // From an earlier run: reactivate and issue a fresh password instead.
  await api("PATCH", "/api/admin/users", { email: TEST_EMAIL, active: true });
  const reset = await api("PATCH", "/api/admin/users", { email: TEST_EMAIL, resetPassword: true });
  temp = reset.body?.temporaryPassword ?? null;
  check("invite (existing test person: reactivated + new password)", !!temp, `HTTP ${reset.status}`);
} else {
  temp = inv.body?.temporaryPassword ?? null;
  check("invite returns a one-time temporary password", inv.status === 200 && !!temp, `HTTP ${inv.status} ${inv.body?.error ?? ""}`);
}
check("temporary password has the expected shape", !!temp && /^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/.test(temp));

const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: TEST_EMAIL, password: temp }) });
const setCookie = login.headers.get("set-cookie") || "";
const tok = (setCookie.match(/bs_sso=([^;]+)/) || [])[1];
const sess = tok ? await verifySso(SECRET, tok) : null;
check("the invited person can sign in with it", login.status === 200 && !!sess, `HTTP ${login.status}`);
check("their token carries exactly the chosen tools", !!sess && JSON.stringify([...sess.grants].sort()) === JSON.stringify(["clients", "search"]), sess ? sess.grants.join(",") : "no session");

/* ---- the invited person sets their own password ---- */
const OWN = "my-own-long-password-2026";
const meRes = tok ? await fetch(BASE + "/api/auth/password", { headers: { cookie: `bs_sso=${tok}` } }) : null;
const me = meRes ? await meRes.json().catch(() => null) : null;
check("their account says a password change is due", !!me && me.canChange === true && me.mustChangePassword === true, JSON.stringify(me));
const badChange = tok ? await fetch(BASE + "/api/auth/password", { method: "POST", headers: { cookie: `bs_sso=${tok}`, "content-type": "application/json" }, body: JSON.stringify({ current: "nope", next: OWN }) }) : null;
check("a wrong current password is refused", !!badChange && badChange.status === 401, badChange ? `HTTP ${badChange.status}` : "no token");
const shortChange = tok ? await fetch(BASE + "/api/auth/password", { method: "POST", headers: { cookie: `bs_sso=${tok}`, "content-type": "application/json" }, body: JSON.stringify({ current: temp, next: "short" }) }) : null;
check("a too-short new password is refused", !!shortChange && shortChange.status === 400, shortChange ? `HTTP ${shortChange.status}` : "no token");
const change = tok ? await fetch(BASE + "/api/auth/password", { method: "POST", headers: { cookie: `bs_sso=${tok}`, "content-type": "application/json" }, body: JSON.stringify({ current: temp, next: OWN }) }) : null;
const newTok = change ? ((change.headers.get("set-cookie") || "").match(/bs_sso=([^;]+)/) || [])[1] : null;
check("they can set their own password and stay signed in", !!change && change.status === 200 && !!newTok, change ? `HTTP ${change.status}` : "no token");
const oldRefresh = tok ? await fetch(BASE + "/api/auth/refresh", { method: "POST", headers: { cookie: `bs_sso=${tok}` } }) : null;
check("their previous session token no longer refreshes", !!oldRefresh && oldRefresh.status === 401, oldRefresh ? `HTTP ${oldRefresh.status}` : "no token");
const loginOwn = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: TEST_EMAIL, password: OWN }) });
const loginOwnBody = await loginOwn.json().catch(() => ({}));
check("they can sign in with the new password, no change demanded", loginOwn.status === 200 && loginOwnBody.mustChangePassword === false, `HTTP ${loginOwn.status} mustChange=${loginOwnBody.mustChangePassword}`);
const loginTemp = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: TEST_EMAIL, password: temp }) });
check("the temporary password no longer works", loginTemp.status === 401, `HTTP ${loginTemp.status}`);
// The Owner can change theirs here too — proven only as far as "a wrong current
// password is refused": the real admin's password is never touched by a test.
const ownerChange = await fetch(BASE + "/api/auth/password", { method: "POST", headers: { cookie: `bs_sso=${admin}`, "content-type": "application/json" }, body: JSON.stringify({ current: "not-the-real-one", next: OWN }) });
check("an Owner may change their password here (wrong current password refused, not 'managed elsewhere')", ownerChange.status === 401, `HTTP ${ownerChange.status}`);
// the deactivation checks below use the temp password; make them use the person's own
temp = OWN;

const wrong = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: TEST_EMAIL, password: "wrong-wrong-wrong-wrong" }) });
check("a wrong password is refused", wrong.status === 401, `HTTP ${wrong.status}`);

const listed = await api("GET", "/api/admin/users");
const row = (listed.body?.users || []).find((u) => u.email === TEST_EMAIL);
check("the person appears on the screen's list as invited", !!row && row.source === "db" && row.name === "Test Invite" && row.isActive === true, JSON.stringify(row));
check("an invited person is a Member, never an Owner", !!row && row.isAdmin === false && row.role === "Member", row ? `${row.role} isAdmin=${row.isAdmin}` : "no row");

const ownerEdit = await api("PATCH", "/api/admin/users", { email: "admin@outreachify.io", grants: ["inbox"] });
check("an Owner's grants cannot be changed", ownerEdit.status === 409, `HTTP ${ownerEdit.status} ${ownerEdit.body?.error ?? ""}`);
const selfEdit = await api("PATCH", "/api/admin/users", { email: "admin@outreachify.io", active: false });
check("an admin cannot deactivate themselves", selfEdit.status === 400, `HTTP ${selfEdit.status}`);

const off = await api("PATCH", "/api/admin/users", { email: TEST_EMAIL, active: false });
check("deactivate succeeds", off.status === 200, `HTTP ${off.status}`);
const loginOff = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: TEST_EMAIL, password: temp }) });
check("a deactivated person cannot sign in", loginOff.status === 401, `HTTP ${loginOff.status}`);
const refresh = tok ? await fetch(BASE + "/api/auth/refresh", { method: "POST", headers: { cookie: `bs_sso=${tok}` } }) : null;
check("their existing session cannot refresh", !!refresh && refresh.status === 401, refresh ? `HTTP ${refresh.status}` : "no token");

const listed2 = await api("GET", "/api/admin/users");
const row2 = (listed2.body?.users || []).find((u) => u.email === TEST_EMAIL);
check("the list shows them deactivated", !!row2 && row2.isActive === false);

console.log(`\n${"=".repeat(72)}\n  ${passed} of ${passed + failed} passed${failed ? `\n  FAILED:\n${fails.map((f) => "      " + f).join("\n")}` : ""}\n`);
process.exit(failed ? 1 : 0);
