/*
 * format.ts — the tool's own display and export rules.
 *
 * Small, but every one of these is copied rather than reinvented, because each
 * encodes a decision that is invisible until it is wrong:
 *
 *   toCsv       leads with a UTF-8 BOM. Without it Excel renders "Peña" as
 *               "PeÃ±a" and the client reports the export as broken.
 *   mlsDisplayName  a CTD_ code with no name is not an MLS at all.
 *   importNote  turns a status word into the sentence a human needs.
 *   splitLocations  splits on newline and ';' but NEVER ',' — "Miami, FL".
 */

import { MONEY_COLUMNS, URL_COLUMNS } from "./columns.ts";

/*
 * CSV writer. Verbatim from web/server/index.js `toCsv`.
 *
 * The export endpoint is proxied to the live service, so this is used for
 * client-side exports of data the workspace already holds (the master list a
 * screen has in memory). Same bytes either way — which is the point.
 */
export function toCsv(rows: Record<string, unknown>[], cols: readonly string[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.map(esc).join(",");
  const lines = rows.map((r) => cols.map((c) => esc(r[c])).join(","));
  // Lead with a UTF-8 BOM so Excel renders accents / —  / ® correctly.
  return "﻿" + [header, ...lines].join("\n");
}

/*
 * An MLS with no name whose code is a Courted-internal CTD_ bucket isn't a real
 * MLS — it's a custom/manually-added list inside Courted. Relabel it so it reads
 * clearly instead of showing a raw hex code.
 *
 * Verbatim from web/public/app.js `mlsDisplayName`.
 */
export function mlsDisplayName(m: { code: string; name?: string | null }): string {
  const name = String(m.name || "").trim();
  if ((!name || name === m.code) && /^CTD_/i.test(m.code)) return "Custom list (Courted)";
  return name || m.code;
}

/*
 * Human-readable reason for the rows that weren't written as new — so a blocked
 * or errored URL explains itself in the table instead of only bumping a counter.
 *
 * Verbatim from web/public/app.js `importNote`.
 */
export function importNote(r: { status?: string; message?: string }): string {
  if (r.status === "error") return r.message || "scrape error";
  if (r.status === "blocked") return "blocked — page too small (likely CAPTCHA / anti-bot); retry later";
  if (r.status === "dead") return "no agent found on the page";
  if (r.status === "skipped") return "already in the database";
  return r.message || "";
}

/*
 * Split the locations box.
 *
 * Verbatim from web/public/app.js `startSearch`: "Split on NEW LINES /
 * semicolons only — NOT commas (a "City, ST" has a comma)." Splitting on
 * commas would turn one location into two useless ones and is the kind of bug
 * that only shows up as a scrape returning nothing.
 */
export function splitLocations(text: string): string[] {
  return text.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
}

/** How one cell renders. Verbatim rules from app.js `cell`. */
export type CellKind = { kind: "empty" } | { kind: "link"; href: string } | { kind: "money"; text: string } | { kind: "text"; text: string };

export function cellKind(col: string, val: unknown): CellKind {
  if (val == null || val === "") return { kind: "empty" };
  if (URL_COLUMNS.has(col)) return { kind: "link", href: String(val) };
  if (MONEY_COLUMNS.has(col) && /^\d+$/.test(String(val))) {
    return { kind: "money", text: "$" + Number(val).toLocaleString("en-US") };
  }
  return { kind: "text", text: String(val) };
}

/*
 * Count badge text: "fetched / total" once the matched total is known.
 * Verbatim logic from app.js `updateCount`.
 *
 * `serverCount` matters more than it looks: a full-sweep run streams straight
 * to the database and never fills the table, so counting rendered rows alone
 * would show 0 through an hour-long sweep.
 */
export function countLabel(rendered: number, serverCount: number, total: number | null): string {
  const n = Math.max(rendered, serverCount || 0);
  return (total != null && total !== n)
    ? `${n.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}`
    : n.toLocaleString("en-US");
}
