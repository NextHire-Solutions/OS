"use client";

/*
 * The Demo Portal's saves, from the page (21 Oct). Every client in the preview
 * is read-only except the Demo Portal; there, the design's buttons work and
 * each one sends one action to /api/crm-preview/demo (lib/crm-preview/demo.ts
 * says what it writes — the Demo Portal's own rows, nothing outside).
 *
 * `live` is the server's word (page.tsx: isDemoPortal), and the route checks
 * the portal again on every save — the browser cannot widen it.
 */

import { createContext, useContext } from "react";

import { parseCsv, type CsvRow } from "@/lib/tools/master-inbox/portals/csv";
import { STAGE_ORDER } from "@/lib/tools/master-inbox/portals/stages-shared";

import { RO } from "./k";

export type DemoAction = { type: string } & Record<string, unknown>;

export interface DemoCtx {
  /** This viewer's buttons save here (page.tsx editable: the Demo for its viewers, a real portal for its own signed-in client). */
  live: boolean;
  /** The Demo Portal — its saves reach nothing outside, and the wording says so. */
  demo: boolean;
  /** One save; true when it was saved (the page then reloads its data). */
  save: (action: DemoAction) => Promise<boolean>;
  /** A note in the preview's toast (red when `bad`). */
  say: (text: string, bad?: boolean) => void;
}

export const DemoContext = createContext<DemoCtx>({ live: false, demo: false, save: async () => false, say: () => {} });
export const useDemo = () => useContext(DemoContext);

/** The read-only marks (k.ts RO) where the portal cannot be changed; none on the Demo Portal. */
export const lock = (live: boolean) => (live ? {} : RO);

const CANONICAL = new Set<string>(STAGE_ORDER);

/** A key that is one of the pipeline's own stages (not a portal's custom stage). */
export const isCanonicalStage = (key: string) => CANONICAL.has(key);

/** Moving agents to a stage or tag: a pipeline stage, or one of the portal's own (custom) stages. */
export function moveTo(ids: readonly string[], key: string): DemoAction {
  return CANONICAL.has(key) ? { type: "entry.stage", ids: [...ids], stage: key } : { type: "entry.customStage", ids: [...ids], key };
}

export async function postDemo(client: string, action: DemoAction): Promise<{ ok: true; id?: string; message?: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/crm-preview/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client, action }),
      // An import of a few thousand rows takes longer than one save.
      signal: AbortSignal.timeout(action.type.endsWith(".import") ? 120_000 : 30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
    return res.ok ? { ok: true, id: j.id, message: j.message } : { ok: false, error: j.error ?? "That could not be saved." };
  } catch {
    // An import may have finished on the server after the browser stopped waiting (22 Oct audit): say so, so it isn't simply run twice.
    // A save that timed out may still have been made (28 Oct audit): never "nothing was saved" — run twice, an Add is a duplicate.
    return { ok: false, error: action.type.endsWith(".import") ? "No answer within two minutes — the import may still have finished. Check the list before importing the file again." : "No answer from the server — it may still have saved. Reload the page and check before trying again." };
  }
}

/* As the live import routes: 5 MB a file, 5,000 rows (lib/crm-preview/demo.ts MAX_IMPORT_ROWS — demo.test.ts keeps them equal). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

/**
 * A CSV import on the Demo Portal: the file is read here with the live
 * portal's own parser and header matching (`map`: portals/csv.ts
 * csvRowToAgent / csvRowToDnc / csvRowToTeam / csvRowToPipeline), and its
 * rows are one save. The server checks each row again and says what it did.
 */
export async function importCsv(file: File, map: (row: CsvRow) => object | null, type: string, demo: DemoCtx): Promise<boolean> {
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
    demo.say("Choose a .csv file. From Excel or Google Sheets, save or download the sheet as CSV first.", true);
    return false;
  }
  if (file.size > MAX_FILE_BYTES) {
    demo.say("That file is over 5 MB. Split it into smaller files and import each one.", true);
    return false;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    demo.say("That file couldn't be read. Save it again as CSV and try once more.", true);
    return false;
  }
  // A cell longer than any field allows is cut just past the limit, so the server names its row instead of refusing the whole file (22 Oct audit).
  const clip = (r: object | null) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && v.length > 20_001 ? v.slice(0, 20_001) : v])) : null);
  const rows = parseCsv(text).map(map).map(clip);
  const lines = csvRowLines(text);
  if (!rows.length) {
    demo.say("That file has no rows under its header row.", true);
    return false;
  }
  if (rows.length > MAX_ROWS) {
    demo.say(`That file has ${rows.length.toLocaleString("en-US")} rows; 5,000 is the most at a time. Split it and import each part.`, true);
    return false;
  }
  // The spreadsheet's own line numbers, when they line up with the rows (they always should — parseCsv's rules, followed in csvRowLines).
  return demo.save({ type, rows, ...(lines.length === rows.length ? { lines } : {}) });
}

/**
 * The spreadsheet line each data row starts on, splitting and dropping rows
 * exactly as parseCsv does (quoted line breaks, blank and comma-only lines),
 * so a skipped row is named by the line a person sees (22 Oct audit: one
 * blank line put every later row number off by one).
 */
export function csvRowLines(text: string): number[] {
  const src = text.replace(/^\uFEFF/, "");
  const starts: number[] = [];
  const filled: boolean[] = [];
  let line = 1;
  let recordStart = 1;
  let inQuotes = false;
  let cell = "";
  let row: string[] = [];
  const end = () => {
    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      starts.push(recordStart);
      filled.push(row.some((c) => c.trim().length > 0));
    }
    row = [];
    cell = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (c === "\n" || (c === "\r" && src[i + 1] !== "\n")) line++;
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      end();
      if (c === "\r" && src[i + 1] === "\n") i++;
      line++;
      recordStart = line;
      continue;
    }
    cell += c;
  }
  end();
  // The first record is the header; then only rows with something in them, as parseCsv keeps them.
  return starts.slice(1).filter((_, k) => filled[k + 1]);
}

/** Rows as a CSV the browser saves — the client's own lists only (never Market or Prospects). */
export function saveCsv(filename: string, header: string[], rows: Array<Array<string | null | undefined>>): void {
  const cell = (v: string | null | undefined) => `"${csvSafe(String(v ?? "")).replace(/"/g, '""')}"`;
  const text = [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // In the page and revoked a moment later: some browsers drop a download whose link is gone at once (22 Oct audit).
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * A cell a spreadsheet would run as a formula ("=HYPERLINK(…)", "@SUM(…)",
 * "+cmd|…") is kept as text (22 Oct audit). A phone number or a plain number
 * ("+1 (843) 555-0142", "-5") is left as it is, so it imports back unchanged.
 */
export function csvSafe(v: string): string {
  if (/^[=@\t\r]/.test(v)) return `'${v}`;
  if (/^[+-]/.test(v) && !/^[+-][\d\s().-]*$/.test(v)) return `'${v}`;
  return v;
}

/** A form's named fields, trimmed (inputs and text areas inside `root`). */
export function fieldValues(root: HTMLElement | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) return out;
  // A tick box is "true" when ticked, else "" (its value is "on" either way).
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name], textarea[name], select[name]")) {
    out[el.name] = el instanceof HTMLInputElement && el.type === "checkbox" ? (el.checked ? "true" : "") : el.value.trim();
  }
  return out;
}
