/*
 * Screenshot each settings tab, so the rebuild can be LOOKED at rather than
 * only asserted about.
 *
 *   node scripts/settings-shot.mjs <baseUrl> <outDir> [width]
 *
 * Chrome on 9451, the port this piece of work owns.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] || "http://localhost:3370";
const OUT = process.argv[3] || "/tmp";
const WIDTH = Number(process.argv[4] || 1440);
const CDP = "http://localhost:9451";

const { mintSso, ALL_TOOLS } = await import("../src/lib/bs-auth.ts");
const raw = fs.readFileSync(".env.local", "utf8");
const pick = (k) => {
  const m = raw.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
};
const cookie = await mintSso(pick("BS_SSO_SECRET") || pick("AUTH_SECRET"), {
  email: "admin@outreachify.io",
  grants: [...ALL_TOOLS],
  ver: 1,
});

const TABS = process.argv[5]
  ? [process.argv[5]]
  : ["labels", "templates", "reply-agents", "ai-labeling", "clients", "members", "personal", "webhooks"];

for (const tab of TABS) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  };
  const send = (mm, p = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method: mm, params: p }));
    });
  const ev = async (x) =>
    (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: 950,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Network.setCookie", { name: "bs_sso", value: cookie, domain: "localhost", path: "/" });
  await send("Page.navigate", { url: `${BASE}/inbox/settings/${tab}` });
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await ev("document.readyState")) === "complete" && (await ev(".mis") !== undefined)) {
      const has = await ev(`document.querySelectorAll('.mis').length`);
      if (has > 0) break;
    }
  }
  await new Promise((r) => setTimeout(r, 700));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, `set-${tab}-${WIDTH}.png`);
  fs.writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log(`  ${file}`);
  await fetch(`${CDP}/json/close/${t.id}`);
}
