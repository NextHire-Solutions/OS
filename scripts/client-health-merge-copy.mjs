#!/usr/bin/env node
/*
 * Client Health → Master Inbox merge (migrations/0057_client_health_schema.sql): copies Client Health's six tables
 * from its own Supabase project into the Master Inbox project's `client_health` schema, and proves the copy.
 *
 *   SRC_URL / SRC_KEY   Client Health's project URL + service key  (read only: this script never writes there)
 *   DST_URL / DST_KEY   Master Inbox's project URL + service key   (writes only to the client_health schema)
 *   SRC_SCHEMA / DST_SCHEMA   default: public / client_health. Swapped for a ROLLBACK (copy changes made after the
 *                             switch back to Client Health's own project): SRC = Master Inbox with SRC_SCHEMA=client_health,
 *                             DST = Client Health with DST_SCHEMA=public, mode delta.
 *
 *   node scripts/client-health-merge-copy.mjs copy     every row, in order; the target tables must be EMPTY
 *   node scripts/client-health-merge-copy.mjs verify   row counts + a content hash per table, both sides; exit 1 if any differ
 *   node scripts/client-health-merge-copy.mjs delta <ISO time>
 *        rows changed in the source since then (written by the old setup between the copy and the switch), upserted
 *
 * Never prints a key. Plain inserts keep every value as it is (updated_at included: the triggers only touch UPDATEs).
 */

const TABLES = [
  // Parents first (weekly_metrics and campaign_toggle_log reference clients).
  { name: "clients", pk: ["id"], changed: ["updated_at"] },
  { name: "bison_campaigns", pk: ["id"], changed: ["updated_at"] },
  { name: "instantly_campaigns", pk: ["id"], changed: ["updated_at"] },
  { name: "weekly_metrics", pk: ["client_id", "week_key"], changed: ["updated_at"] },
  { name: "campaign_toggle_log", pk: ["id"], changed: ["created_at"] },
  { name: "sync_runs", pk: ["id"], changed: ["started_at", "finished_at"] },
];
const PAGE = 1000;
const BATCH = 500;

const env = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`${k} is not set`); process.exit(2); }
  return v.replace(/\/+$/, "");
};
const SRC = { url: env("SRC_URL"), key: env("SRC_KEY"), profile: process.env.SRC_SCHEMA || "public" };
const DST = { url: env("DST_URL"), key: env("DST_KEY"), profile: process.env.DST_SCHEMA || "client_health" };
if (SRC.url === DST.url && SRC.profile === DST.profile) { console.error("source and target are the same tables: refusing"); process.exit(2); }

function headers(side, extra = {}) {
  const h = { apikey: side.key, Authorization: `Bearer ${side.key}`, "Content-Type": "application/json", ...extra };
  if (side.profile) { h["Accept-Profile"] = side.profile; h["Content-Profile"] = side.profile; }
  return h;
}

async function call(side, path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`${side.url}/rest/v1/${path}`, { ...init, headers: headers(side, init.headers) });
    if (r.ok) return r;
    const body = (await r.text()).slice(0, 300);
    // Reads may be retried; a write is retried only on a 5xx where nothing can have been half-applied (one request = one statement).
    if (r.status >= 500 && attempt < 3) { await new Promise((s) => setTimeout(s, 1500 * attempt)); continue; }
    throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]} → ${r.status}: ${body}`);
  }
}

async function readAll(side, t, filter = "") {
  const order = t.pk.map((c) => `${c}.asc`).join(",");
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const r = await call(side, `${t.name}?select=*${filter}&order=${order}&limit=${PAGE}&offset=${from}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function count(side, t) {
  const r = await call(side, `${t.name}?select=${t.pk[0]}&limit=1`, { headers: { Prefer: "count=exact" } });
  return Number((r.headers.get("content-range") ?? "*/0").split("/")[1]);
}

async function write(t, rows, upsert) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const qs = upsert ? `?on_conflict=${t.pk.join(",")}` : "";
    await call(DST, `${t.name}${qs}`, {
      method: "POST",
      body: JSON.stringify(chunk),
      headers: { Prefer: upsert ? "resolution=merge-duplicates,return=minimal" : "return=minimal" },
    });
  }
}

// One content hash per table: rows in key order, keys sorted, instants compared as instants (+00:00 vs Z).
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const norm = (v) => {
  if (typeof v === "string" && ISO.test(v)) return new Date(v).toISOString();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  return v;
};
async function hash(rows) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  for (const r of rows) h.update(JSON.stringify(norm(r)) + "\n");
  return h.digest("hex").slice(0, 16);
}

const [mode, since] = process.argv.slice(2);

if (mode === "copy") {
  for (const t of TABLES) {
    const have = await count(DST, t);
    if (have) { console.error(`STOP: ${DST.profile}.${t.name} already has ${have} rows; copy needs empty tables (use delta)`); process.exit(1); }
  }
  for (const t of TABLES) {
    const rows = await readAll(SRC, t);
    await write(t, rows, false);
    console.log(`${t.name.padEnd(20)} copied ${rows.length}`);
  }
} else if (mode === "verify") {
  let bad = 0;
  for (const t of TABLES) {
    const [a, b] = await Promise.all([readAll(SRC, t), readAll(DST, t)]);
    const [ha, hb] = [await hash(a), await hash(b)];
    const same = a.length === b.length && ha === hb;
    if (!same) bad++;
    console.log(`${t.name.padEnd(20)} source ${String(a.length).padStart(6)} ${ha} · target ${String(b.length).padStart(6)} ${hb} ${same ? "SAME" : "DIFFERENT"}`);
  }
  console.log(bad ? `${bad} table(s) differ` : "every table identical");
  process.exit(bad ? 1 : 0);
} else if (mode === "delta") {
  if (!since || Number.isNaN(Date.parse(since))) { console.error("delta needs an ISO time"); process.exit(2); }
  const at = new Date(since).toISOString();
  for (const t of TABLES) {
    const filter = t.changed.length === 1 ? `&${t.changed[0]}=gte.${at}` : `&or=(${t.changed.map((c) => `${c}.gte.${at}`).join(",")})`;
    const rows = await readAll(SRC, t, filter);
    if (rows.length) await write(t, rows, true);
    console.log(`${t.name.padEnd(20)} changed since ${at}: ${rows.length} upserted`);
  }
} else {
  console.error("usage: copy | verify | delta <ISO time>");
  process.exit(2);
}
