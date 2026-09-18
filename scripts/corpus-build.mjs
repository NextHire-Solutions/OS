/*
 * Build the reply corpus on the SERVER, and watch it happen.
 *
 * The build cannot run on a laptop: it needs MASTER_INBOX_APP_ENCRYPTION_KEY
 * to decrypt the reply agent's OpenAI key for embeddings, and that key exists
 * only on Railway. So this script is a remote control — it POSTs the job route
 * and then polls GET until the job stops, printing what changed.
 *
 * Read-only against everything except os_reply_examples, which the job writes.
 *
 *   node --experimental-strip-types scripts/corpus-build.mjs          # status only
 *   node --experimental-strip-types scripts/corpus-build.mjs --start  # kick it off
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://os.brokerstaffer.com";
const START = process.argv.includes("--start");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => { const m = raw.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined; };
const TOKEN = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), { email: "admin@outreachify.io", grants: [...ALL_TOOLS], ver: 1 });

const api = async (path, init = {}) => {
  const res = await fetch(BASE + path, { ...init, headers: { cookie: `bs_sso=${TOKEN}`, ...(init.headers || {}) } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
};

const PATH = "/api/tools/master-inbox/ai/corpus";

if (START) {
  const started = await api(PATH, { method: "POST" });
  console.log("POST", started.status, JSON.stringify(started.json));
  if (started.status !== 200 && started.json?.reason !== "already-running") process.exit(1);
}

let last = "";
for (let i = 0; i < 400; i++) {
  const { status, json } = await api(PATH);
  if (status !== 200) { console.log("GET", status, JSON.stringify(json)); process.exit(1); }
  const line = `${json.running ? "RUNNING" : "idle   "}  examples=${json.examples} embedded=${json.embedded}  ${json.note || ""}`;
  if (line !== last) { console.log(new Date().toISOString().slice(11, 19), line); last = line; }
  if (!json.running) {
    console.log("\n--- FINAL ---");
    console.log(JSON.stringify({ examples: json.examples, embedded: json.embedded, lastBuiltAt: json.lastBuiltAt, error: json.error, startedAt: json.startedAt, finishedAt: json.finishedAt }, null, 2));
    console.log("byLabel:", JSON.stringify(json.byLabel, null, 2));
    if (json.report) console.log("report:", JSON.stringify(json.report, null, 2));
    break;
  }
  await sleep(5000);
}
