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
  /** True only on the Demo Portal. */
  live: boolean;
  /** One save; true when it was saved (the page then reloads its data). */
  save: (action: DemoAction) => Promise<boolean>;
  /** A note in the preview's toast (red when `bad`). */
  say: (text: string, bad?: boolean) => void;
}

export const DemoContext = createContext<DemoCtx>({ live: false, save: async () => false, say: () => {} });
export const useDemo = () => useContext(DemoContext);

/** The read-only marks (k.ts RO) where the portal cannot be changed; none on the Demo Portal. */
export const lock = (live: boolean) => (live ? {} : RO);

const CANONICAL = new Set<string>(STAGE_ORDER);

/** Moving agents to a stage or tag: a pipeline stage, or one of the portal's own (custom) stages. */
export function moveTo(ids: readonly string[], key: string): DemoAction {
  return CANONICAL.has(key) ? { type: "entry.stage", ids: [...ids], stage: key } : { type: "entry.customStage", ids: [...ids], key };
}

export async function postDemo(client: string, action: DemoAction): Promise<{ ok: true; id?: string; message?: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/crm-preview/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client, action }),
      // An import of a few thousand rows takes longer than one save.
      signal: AbortSignal.timeout(action.type.endsWith(".import") ? 120_000 : 30_000),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
    return res.ok ? { ok: true, id: j.id, message: j.message } : { ok: false, error: j.error ?? "That could not be saved." };
  } catch {
    return { ok: false, error: "Couldn't reach the server — nothing was saved." };
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
  const rows = parseCsv(await file.text()).map(map);
  if (!rows.length) {
    demo.say("That file has no rows under its header row.", true);
    return false;
  }
  if (rows.length > MAX_ROWS) {
    demo.say(`That file has ${rows.length.toLocaleString("en-US")} rows; 5,000 is the most at a time. Split it and import each part.`, true);
    return false;
  }
  return demo.save({ type, rows });
}

/** Rows as a CSV the browser saves — the client's own lists only (never Market or Prospects). */
export function saveCsv(filename: string, header: string[], rows: Array<Array<string | null | undefined>>): void {
  const cell = (v: string | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const text = [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A form's named fields, trimmed (inputs and text areas inside `root`). */
export function fieldValues(root: HTMLElement | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) return out;
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[name], textarea[name]")) out[el.name] = el.value.trim();
  return out;
}
