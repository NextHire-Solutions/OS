import "server-only";

import type { GuardRole } from "@/lib/crm-preview/data-guard";
import { agentsByIds, type AgentRow } from "@/lib/crm-preview/demo-market";
import { matchingIds, type MarketContext } from "@/lib/crm-preview/market";
import type { MarketQuery } from "@/lib/crm-preview/market-model";

/*
 * EXPORT (2 Nov 2026 — Amy asked; the user decided "Clients: Prospects only"): a client downloads its own Prospects
 * (the agents in its campaigns, and the ones it moved there); our staff, Prospects and Market. The columns on screen —
 * never an email or a phone (the no-scraping rule, 17 Oct) — at most EXPORT_MAX agents a file; past that, narrow the
 * filters. Every client export is counted and rings the OS bell (route).
 */
export const EXPORT_MAX = 10_000;

export const EXPORT_COLUMNS = ["Name", "Title", "Brokerage", "Office", "Office city", "Most transacted city", "Sales volume", "Units", "Years in industry"] as const;

/** Who may export which list: Prospects, anyone who may open the portal; Market, our staff only. */
export function mayExport(role: GuardRole, list: "market" | "prospects"): boolean {
  return list === "prospects" || role === "staff";
}

/**
 * One CSV cell. Quoted when it holds a comma, a quote or a line break; a cell a spreadsheet would read as a formula
 * (=, +, -, @, a tab or a carriage return first) gets a leading apostrophe, so opening the file never runs anything.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The columns on screen, for one agent — the brokerage as the list shows it (the brand, else the office). */
export function exportLine(a: AgentRow): unknown[] {
  const months = typeof a.est_time_in_industry_months === "number" && Number.isFinite(a.est_time_in_industry_months) ? a.est_time_in_industry_months : null;
  return [a.full_name, a.title, a.brand || a.office_name, a.office_name, a.office_city, a.most_transacted_city, a.sales_volume, a.units, months === null ? null : Math.floor(months / 12)];
}

/** The file: a header row, then one row per agent, as Excel and Google Sheets read it (CRLF; a BOM for the accents). */
export function toCsv(rows: readonly AgentRow[]): string {
  const lines = [EXPORT_COLUMNS.map(csvCell).join(","), ...rows.map((a) => exportLine(a).map(csvCell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** The file's name: "<Client> Prospects 2026-11-02.csv" — only letters, digits, spaces and a few marks. */
export function exportFileName(client: string | null, list: "market" | "prospects", day: string): string {
  const who = (client ?? "").replace(/[^A-Za-z0-9 &.()-]+/g, " ").replace(/\s+/g, " ").trim() || "Portal";
  return `${who} ${list === "prospects" ? "Prospects" : "Market"} ${day}.csv`;
}

/** The agents of the list as filtered and sorted on screen — every one, up to EXPORT_MAX; more is refused (tooMany). */
export async function exportRows(ctx: MarketContext, q: MarketQuery): Promise<{ unavailable: string } | { tooMany: number } | { rows: AgentRow[] }> {
  const found = await matchingIds(ctx, q, EXPORT_MAX);
  if ("unavailable" in found) return found;
  if (found.total > EXPORT_MAX) return { tooMany: found.total };
  const byId = new Map((await agentsByIds(found.ids)).map((a) => [a.id, a]));
  return { rows: found.ids.map((id) => byId.get(id)).filter((a): a is AgentRow => !!a) };
}
