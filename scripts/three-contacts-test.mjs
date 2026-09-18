/*
 * Three contacts, end to end on the deployed site, on a THROWAWAY client the
 * test creates and deletes. No real client is touched.
 */
import fs from "node:fs";
const BASE = "https://os.brokerstaffer.com";
const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });
const H = { cookie: `bs_sso=${TOKEN}`, "content-type": "application/json" };
const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const U = pick("MASTER_INBOX_SUPABASE_URL"), K = pick("MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY");
const SBH = { apikey: K, Authorization: `Bearer ${K}` };
const sb = async (p) => (await fetch(`${U}/rest/v1/${p}`, { headers: SBH })).json();

let passed = 0, failed = 0; const fails = [];
const check = (n, ok, d = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  —  " + d : ""}`); ok ? passed++ : (failed++, fails.push(n)); };

const STAMP = Date.now();
const NAME = `ZZ Three Contacts ${STAMP}`;
console.log(`\nTHREE CONTACTS, LIVE\n${"=".repeat(74)}\n`);

let osId = null, tplId = null;
try {
  const created = await api("POST", "/api/workspace/clients/adopt", { name: NAME, aliases: [] });
  osId = created.body?.id ?? created.body?.client?.id ?? null;
  check("a throwaway client is created", !!osId, `HTTP ${created.status}`);
  if (!osId) throw new Error(JSON.stringify(created.body).slice(0, 200));

  // Half a person must be refused.
  const bad = await api("POST", "/api/workspace/clients/edit", { id: osId,
    contactName: "Nicole Collins", contactRole: "Team Leader", brokerage: "Oz Group",
    contact2Name: "Shaurs Patel",
  });
  check("a second person with no role is refused", bad.status === 400, `HTTP ${bad.status} ${bad.body?.error ?? ""}`);

  const ok = await api("POST", "/api/workspace/clients/edit", { id: osId,
    contactName: "Nicole Collins", contactRole: "Team Leader", contactEmail: `one-${STAMP}@brokerstaffer.test`,
    contact2Name: "Shaurs Patel", contact2Role: "Managing Broker", contact2Email: `two-${STAMP}@brokerstaffer.test`,
    contact3Name: "Eddy Chen", contact3Role: "Broker and Owner", contact3Email: `three-${STAMP}@brokerstaffer.test`,
    brokerage: "Oz Group",
  });
  check("three people save in one go", ok.status === 200, `HTTP ${ok.status} ${JSON.stringify(ok.body?.updated ?? ok.body?.error ?? "")}`);

  const [row] = await sb(`os_clients?select=contact_name,contact2_name,contact3_name,contact3_role&id=eq.${osId}`);
  check("all three are stored on the record",
    row?.contact_name === "Nicole Collins" && row?.contact2_name === "Shaurs Patel" && row?.contact3_name === "Eddy Chen",
    JSON.stringify(row));

  const [tpl] = await sb(`reply_templates?select=id,body,cc&name=eq.${encodeURIComponent(`Intro Macro - ${NAME}`)}`);
  tplId = tpl?.id ?? null;
  check("the stored template is written", !!tpl, tplId ?? "missing");
  const line = (tpl?.body ?? "").split("\n").find((l) => l.startsWith("I'd like")) ?? "";
  check("it names all three on one line",
    line === "I'd like to introduce you to Nicole Collins, Team Leader, Shaurs Patel, Managing Broker, and Eddy Chen, Broker and Owner at Oz Group",
    line);
  check("it addresses all three together",
    (tpl?.body ?? "").includes("\nNicole, Shaurs and Eddy, I recently connected"));
  check("every address is in the template's Cc",
    ["one", "two", "three"].every((n) => (tpl?.cc ?? "").includes(`${n}-${STAMP}@brokerstaffer.test`)), tpl?.cc ?? "");

  /*
   * An edit carries only what CHANGED. Correcting one field of a person who
   * is already saved must not read as "this person has no name" — the first
   * version of this check looked only at the edit and refused exactly that,
   * which broke ordinary role corrections.
   */
  const roleOnly = await api("POST", "/api/workspace/clients/edit", { id: osId, contactRole: "Broker Associate" });
  check("correcting only a role, on a contact already saved, is allowed",
    roleOnly.status === 200, `HTTP ${roleOnly.status} ${roleOnly.body?.error ?? ""}`);
  const [tplR] = await sb(`reply_templates?select=body&name=eq.${encodeURIComponent(`Intro Macro - ${NAME}`)}`);
  check("the new role reaches the stored template",
    (tplR?.body ?? "").includes("Nicole Collins, Broker Associate"),
    ((tplR?.body ?? "").split("\n").find((l) => l.startsWith("I'd like")) ?? "").slice(0, 80));
  const emailOnly = await api("POST", "/api/workspace/clients/edit", { id: osId, contact2Email: `two-b-${STAMP}@brokerstaffer.test` });
  check("correcting only a second person's email is allowed",
    emailOnly.status === 200, `HTTP ${emailOnly.status} ${emailOnly.body?.error ?? ""}`);
  await api("POST", "/api/workspace/clients/edit", { id: osId, contactRole: "Team Leader" });

  // Removing the third person must take them back out of the sentence.
  const shrink = await api("POST", "/api/workspace/clients/edit", { id: osId, contact3Name: "", contact3Role: "", contact3Email: "" });
  check("a person can be removed", shrink.status === 200, `HTTP ${shrink.status}`);
  const [tpl2] = await sb(`reply_templates?select=body,cc&name=eq.${encodeURIComponent(`Intro Macro - ${NAME}`)}`);
  const line2 = (tpl2?.body ?? "").split("\n").find((l) => l.startsWith("I'd like")) ?? "";
  check("the sentence drops back to two people",
    line2 === "I'd like to introduce you to Nicole Collins, Team Leader, and Shaurs Patel, Managing Broker at Oz Group", line2);
  check("their address is dropped from Cc too", !(tpl2?.cc ?? "").includes(`three-${STAMP}`), tpl2?.cc ?? "");
} catch (e) {
  check("the run completed", false, e instanceof Error ? e.message : String(e));
}

console.log("\nCleaning up\n");
if (tplId) { const d = await api("DELETE", `/api/tools/master-inbox/reply-templates/${tplId}`); check("the test template is removed", [200, 204].includes(d.status), `HTTP ${d.status}`); }
if (osId) { const d = await api("POST", "/api/workspace/clients/delete", { id: osId, scope: "os", confirm: NAME }); check("the throwaway client is removed", d.status === 200 && (d.body?.failed ?? []).length === 0, `HTTP ${d.status}`); }
console.log(`\n${"=".repeat(74)}\n  ${passed} of ${passed + failed} passed${failed ? `\n  FAILED:\n${fails.map((f) => "      " + f).join("\n")}` : ""}\n`);
process.exit(failed ? 1 : 0);
