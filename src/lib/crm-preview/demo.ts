/*
 * The Demo Portal, working (21 Oct). The user: make the new portal "fully
 * working (real saves …) for the Demo Portal ONLY. Every real client's portal
 * stays untouched." Eddy asked to try the design on the Demo Portal before
 * anything is launched.
 *
 * Every other client in the preview stays read-only. This file is the one
 * place the preview writes, and it writes only the Demo Portal's own rows:
 *
 *   - the portal is fixed here, on the server (DEMO_PORTAL_ID) — never taken
 *     from the browser; every update and delete is also filtered by it, so
 *     an id from another client changes nothing;
 *   - the rows are the ones the live portal writes (Master Inbox
 *     app/api/portal/[token]/*), with the same columns and defaults;
 *   - NOTHING the live portal sets off around a save happens here — on
 *     purpose (survey, 21 Oct). There, a DNC company goes onto the EmailBison
 *     and Instantly blocklists every client's campaigns share (and is never
 *     taken off), a DNC agent is unsubscribed across every client's campaigns,
 *     a My Agents email is blocked workspace-wide, every change posts to the
 *     shared Slack channels, and an Introduction texts Eddy, Ryan and Amy.
 *     None of those modules is imported here (demo.test.ts pins it), and new
 *     team members are saved with texts off.
 *
 * What a Demo save still reaches, by design of the database: the reply
 * agent's safety check reads every client's DNC addresses, so a Demo DNC
 * email also stops automatic replies to that address — the cautious way.
 *
 * CSV imports (22 Oct): the browser reads the file with the live portal's own
 * parser and header matching (portals/csv.ts) and sends the rows. Each row is
 * checked again here with the live import routes' rules; a row that cannot be
 * saved is skipped and named, instead of failing the whole file. Duplicates
 * are skipped as live: My Agents by email, DNC by email (agents) or domain
 * (companies), Team by name + email; pipeline rows are not de-duplicated (nor
 * are they live). Nothing a live import sets off happens here either — no
 * blocklists, no stop, no Slack, no Introduction texts, no Follow Up Boss.
 *
 * Manage stages (22 Oct): the live portal's own save (Master Inbox
 * app/api/portal/[token]/stages, behind `manage_stages` — a flag only the
 * Demo Portal has) with its rules: every pipeline stage stays, exactly once
 * (it can be renamed, moved or hidden, never removed); a removed custom stage
 * first takes its agents back to their pipeline stage. It writes only the
 * Demo's `client_pipeline_stages` rows and clears only the Demo's entries'
 * custom-stage placement — never an entry's stage, so no Introduction or
 * Hired is ever set off.
 */

import { z } from "zod";
import { agentsByIds, demoProspectIds, emailsOf, lower, missingTable, PROSPECTS_MIGRATION, type AgentRow, type MoveTarget } from "@/lib/crm-preview/demo-market";
import { personKey } from "@/lib/crm-preview/market-model";

import { ALWAYS_SHOWN, SETUP_OFFERS } from "@/lib/crm-preview/model";
import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { STAGE_LABEL_MAX_LEN, STAGE_ORDER, type PipelineStage } from "@/lib/tools/master-inbox/portals/stages-shared";
import { GLOBAL_CUSTOM_STAGE_KEYS, STAGE_COLOR_PALETTE } from "@/lib/tools/master-inbox/portals/stage-config";

/** The Demo Portal (Master Inbox `clients`, slug demo-portal). The only portal the preview can change. */
export const DEMO_PORTAL_ID = "00ef116c-646d-43b4-a323-680548ea7126";

export function isDemoPortal(id: string | null | undefined): boolean {
  return id === DEMO_PORTAL_ID;
}

/*
 * The Demo Portal's sample market (21 Oct, the user: "yes you can add the demo
 * market in demo portal"). It has no client record, so no market of its own;
 * it shows the Atlanta market the design's own sample data comes from (C21
 * Results' MLSs). Market and Reports read it; Prospects stay unavailable —
 * those are one real client's own lists and never appear in a demo.
 */
export const DEMO_MARKET_MLS: readonly string[] = ["FMLS", "GAMLS"];

const STAGES = STAGE_ORDER as [PipelineStage, ...PipelineStage[]];
const id = z.string().uuid();
// "Select all" on a long list: up to 5,000 at once, written in chunks (eachChunk).
const ids = z.array(id).min(1).max(5000);
const text = (max: number) => z.string().trim().max(max);
const optional = (max: number) => text(max).nullable().optional().transform((v) => (v ? v : null));
const email = z.string().trim().email().max(200);
const optionalEmail = z
  .union([email, z.literal(""), z.null()])
  .optional()
  .transform((v) => (v ? v.toLowerCase() : null));

/** At most this many rows in one file, as live. */
export const MAX_IMPORT_ROWS = 5000;
/* An imported file's rows as the browser mapped them (portals/csv.ts); null where a row had nothing the mapper could read. */
const csvRows = z.array(z.record(z.string().max(64), z.union([z.string().max(20_000), z.boolean(), z.null()])).nullable()).min(1).max(MAX_IMPORT_ROWS);

/* A custom stage's key, as the live portal makes them ("custom_apw2pau5"); a tag the new design adds is "custom_tag_…" (model.ts). */
const CUSTOM_KEY = /^custom_[a-z0-9_]{1,56}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const stageRow = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(STAGE_LABEL_MAX_LEN),
  color: z.string().trim().max(9).nullable().optional(),
  kind: z.enum(["canonical", "custom"]),
  canonical_stage: z.string().trim().nullable().optional(),
  hidden: z.boolean().optional().default(false),
});
/* NUL characters out of every text before anything is checked: the database refuses them, and one in a file failed the whole batch (22 Oct audit). */
const noNul = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/\u0000/g, "")
  : Array.isArray(v) ? v.map(noNul)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNul(x)]))
  : v;

/* The spreadsheet's own line number of each row the browser sends (blank lines are dropped by the parser, so it can't be counted here). */
const lines = z.array(z.number().int().min(1).max(10_000_000)).max(MAX_IMPORT_ROWS).optional();

/** Every save the Demo Portal can make — what its screens' buttons do. */
export const demoAction = z.preprocess(noNul, z.discriminatedUnion("type", [
  z.object({
    type: z.literal("entry.add"),
    lead_name: text(200).min(1),
    lead_email: optionalEmail,
    lead_phone: optional(80),
    current_brokerage: optional(200),
    agent_profile_url: optional(500),
    stage: z.enum(STAGES).optional(),
  }),
  z.object({ type: z.literal("entry.stage"), ids, stage: z.enum(STAGES) }),
  z.object({ type: z.literal("entry.customStage"), ids, key: z.string().max(64).nullable() }),
  z.object({ type: z.literal("entry.assign"), ids, member: id.nullable() }),
  z.object({
    type: z.literal("entry.edit"),
    id,
    lead_name: optional(200),
    lead_email: optionalEmail,
    lead_phone: optional(80),
    current_brokerage: optional(200),
    agent_profile_url: optional(500),
  }),
  // The Edit form's custom fields (23 Oct): set (a value) or cleared (null), merged into the entry's own overrides, as the live portal keeps them.
  z.object({
    type: z.literal("entry.fields"),
    id,
    fields: z.record(z.string().trim().min(1).max(60), z.string().trim().max(500).nullable()).refine((o) => Object.keys(o).length <= 30, "At most 30 fields at once."),
  }),
  z.object({ type: z.literal("entry.delete"), ids }),
  z.object({ type: z.literal("note.add"), entry: id, body: text(20_000).min(1) }),
  z.object({ type: z.literal("agent.add"), name: text(160).min(1), email: optionalEmail, phone: optional(40), license: optional(80) }),
  z.object({ type: z.literal("agent.edit"), id, name: text(160).min(1), email: optionalEmail, phone: optional(40), license: optional(80) }),
  z.object({ type: z.literal("agent.delete"), ids }),
  z.object({
    type: z.literal("dnc.add"),
    kind: z.enum(["agent", "company"]),
    name: text(160).min(1),
    email: optionalEmail,
    phone: optional(40),
    brokerage: optional(160),
    domain: optional(255),
    notes: optional(2000),
  }),
  z.object({ type: z.literal("dnc.edit"), id, name: text(160).min(1), email: optionalEmail, phone: optional(40), brokerage: optional(160), domain: optional(255), notes: optional(2000) }),
  z.object({ type: z.literal("dnc.delete"), ids }),
  z.object({ type: z.literal("team.add"), name: text(120).min(1), email, title: optional(120), phone: optional(40) }),
  z.object({ type: z.literal("team.edit"), id, name: text(120).min(1), email, title: optional(120), phone: optional(40) }),
  z.object({ type: z.literal("team.active"), id, active: z.boolean() }),
  z.object({ type: z.literal("team.delete"), ids }),
  z.object({ type: z.literal("entry.import"), rows: csvRows, lines }),
  z.object({ type: z.literal("agent.import"), rows: csvRows, lines }),
  z.object({ type: z.literal("dnc.import"), rows: csvRows, lines }),
  z.object({ type: z.literal("team.import"), rows: csvRows, lines }),
  z.object({ type: z.literal("stages.save"), stages: z.array(stageRow).min(1).max(30) }),
  z.object({
    type: z.literal("offer.save"),
    offers: z.array(z.enum(SETUP_OFFERS)).min(1).max(SETUP_OFFERS.length),
    why_join: text(1000).min(1),
    never_say: optional(1000),
  }),
]));

export type DemoAction = z.infer<typeof demoAction>;
export type DemoResult = { ok: true; id?: string; message?: string } | { ok: false; status: 400 | 404 | 409; error: string };

/** The domain a company entry blocks, normalised as the live portal does (enforce-blocklist.ts normalizeDomain). */
export function companyDomain(raw: string | null): string | null {
  let v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^@/, "").replace(/^www\./, "");
  v = v.split("/")[0] ?? v;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v) ? v : null;
}

/** The slice of a Supabase client used here, so the tests can hand in a fake one. */
export type Db = { from(table: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Res = { data: unknown; error: { message: string; code?: string } | null };
export const failed = (r: Res): DemoResult | null =>
  !r.error ? null
  // The database's own duplicate refusal (an address or domain already on the list) says so, rather than "try again" (22 Oct audit).
  : r.error.code === "23505" ? { ok: false, status: 409, error: "That's already on the list." }
  : { ok: false, status: 400, error: "That could not be saved. Please try again." };

/*
 * Every id-list write in chunks of 200 (22 Oct audit): a longer
 * `id=in.(…)` passes the gateway's URL limit (~16 KB, about 400 ids —
 * intro-leads.ts) and failed every time, so a big list could not be cleared.
 */
export async function eachChunk(all: readonly string[], write: (part: string[]) => PromiseLike<Res>): Promise<DemoResult | null> {
  for (let i = 0; i < all.length; i += 200) {
    const r = await write(all.slice(i, i + 200));
    if (r.error) return failed(r);
  }
  return null;
}
const now = () => new Date().toISOString();

// ------------------------------------------------------------ CSV imports ---

type CsvIn = Record<string, string | boolean | null> | null;
type Skip = { row: number; reason: string };
const EMAIL = z.string().email();

/* One row's fields, trimmed and bounded as the live routes bound them; the first problem names why the row is skipped. */
function rowReader(raw: CsvIn) {
  const problems: string[] = [];
  const get = (key: string, max: number, what: string): string | null => {
    const v = raw && typeof raw[key] === "string" ? (raw[key] as string).trim() : "";
    if (!v) return null;
    if (v.length > max) {
      problems.push(`${what} is longer than ${max} characters`);
      return null;
    }
    return v;
  };
  const email = (key: string): string | null => {
    const v = get(key, 200, "the email");
    if (v && !EMAIL.safeParse(v).success) {
      problems.push(`"${v.slice(0, 60)}" is not a valid email`);
      return null;
    }
    return v ? v.toLowerCase() : null;
  };
  return { get, email, problems, flag: (key: string) => raw?.[key] === true };
}

/* A stage name as the file writes it, made comparable: "We/They Rejected" → "we_they_rejected". */
const stageWord = (s: string) => s.trim().toLowerCase().replace(/[\s/-]+/g, "_");
type CsvStage = { stage: PipelineStage; custom: string | null };

/*
 * A stage as a file may write it: the key ("phone_screen"), its default name
 * ("Phone Screen"), or the portal's OWN name for a stage — renamed ("Nurture")
 * or custom ("Invited to sales meeting"), as the preview's own Export writes
 * them (22 Oct audit: an export did not import back). A custom stage sits on
 * top of Introduction, as the board places one.
 */
function stageFromCsv(raw: string, own: ReadonlyMap<string, CsvStage>): CsvStage | null {
  const word = stageWord(raw);
  if ((STAGE_ORDER as string[]).includes(word)) return { stage: word as PipelineStage, custom: null };
  return own.get(word) ?? null;
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function imported(saved: number, dupes: number, skipped: Skip[], noun: [string, string]): DemoResult {
  const why = skipped.slice(0, 3).map((s) => `row ${s.row}: ${s.reason}`).join("; ") + (skipped.length > 3 ? "; …" : "");
  if (saved === 0 && dupes === 0) return { ok: false, status: 400, error: `Nothing was imported — ${why}.` };
  const parts = [`Imported ${plural(saved, noun[0], noun[1])}.`];
  // A duplicate: already on the list, or a second row for the same person in the file.
  if (dupes) parts.push(`${plural(dupes, "duplicate", "duplicates")} skipped.`);
  if (skipped.length) parts.push(`${plural(skipped.length, "row", "rows")} skipped — ${why}.`);
  return { ok: true, message: parts.join(" ") };
}

/* Inserts in batches; a failure part-way says how many were saved (a re-import then skips them, bar pipeline rows). */
async function insertAll(db: Db, table: string, rows: Array<Record<string, unknown>>): Promise<{ saved: number; dupes: number; error?: DemoResult }> {
  let saved = 0;
  let dupes = 0;
  const partway = (): DemoResult => ({ ok: false, status: 400, error: saved ? `${plural(saved, "row was", "rows were")} saved, then the rest could not be. Please try again.` : "That file could not be saved. Please try again." });
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const r: Res = await db.from(table).insert(batch).select("id");
    if (!r.error) {
      saved += ((r.data as unknown[]) ?? []).length;
      continue;
    }
    // Something on the list since it was read (another save, the live portal): this batch row by row, its duplicates skipped (22 Oct audit).
    if (r.error.code !== "23505") return { saved, dupes, error: partway() };
    for (const one of batch) {
      const o: Res = await db.from(table).insert(one).select("id");
      if (!o.error) saved += 1;
      else if (o.error.code === "23505") dupes += 1;
      else return { saved, dupes, error: partway() };
    }
  }
  return { saved, dupes };
}

/* The Demo Portal's existing rows of a list, every page of them. */
const existing = <T,>(db: Db, table: string, columns: string) =>
  fetchAllRows<T>(({ from, to }) => db.from(table).select(columns).eq("client_id", DEMO_PORTAL_ID).order("id").range(from, to));

async function runImport(db: Db, a: Extract<DemoAction, { rows: unknown }>): Promise<DemoResult> {
  const C = DEMO_PORTAL_ID;
  // The spreadsheet's own row number: as the browser counted it, else the header is row 1 and no line was blank.
  const rowNo = (i: number) => a.lines?.[i] ?? i + 2;
  const skipped: Skip[] = [];
  const out: Array<Record<string, unknown>> = [];
  let dupes = 0;
  switch (a.type) {
    case "entry.import": {
      const st: Res = await db.from("client_pipeline_stages").select("key, label, kind, canonical_stage").eq("client_id", C);
      if (st.error) return failed(st)!;
      const own = new Map<string, CsvStage>();
      for (const r of (st.data ?? []) as Array<{ key: string; label: string; kind: string; canonical_stage: string | null }>) {
        const at: CsvStage = r.kind === "canonical" && r.canonical_stage ? { stage: r.canonical_stage as PipelineStage, custom: null } : { stage: "introduction", custom: r.key };
        own.set(stageWord(r.label), at);
        own.set(stageWord(r.key), at);
      }
      for (const g of GLOBAL_CUSTOM_STAGE_KEYS) if (!own.has(g)) own.set(g, { stage: "introduction", custom: g });
      for (const [g, label] of [["phone_screen_no_show", "Phone screen no show"], ["interview_no_show", "Interview no show"]] as const) if (!own.has(stageWord(label))) own.set(stageWord(label), { stage: "introduction", custom: g });
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("lead_name", 200, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        const lead_email = f.email("lead_email");
        const stageText = f.get("stage", 64, "the stage");
        const placed = stageText ? stageFromCsv(stageText, own) : { stage: "introduction" as PipelineStage, custom: null };
        if (!placed) f.problems.push(`"${stageText!.slice(0, 40)}" is not one of this portal's stages`);
        const dateText = f.get("introduced_at", 64, "the date");
        const parsed = dateText ? new Date(dateText) : null;
        // A real calendar date only: a spreadsheet's date number ("45212") reads as the year 45212, which the database refuses — and it failed the whole batch (22 Oct audit).
        const date = parsed && !Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 1900 && parsed.getUTCFullYear() <= 2100 ? parsed : null;
        if (dateText && !date) f.problems.push(`"${dateText.slice(0, 40)}" is not a date (use a date like 2026-10-01)`);
        const row = {
          client_id: C,
          stage: placed?.stage ?? "introduction",
          custom_stage_key: placed?.custom ?? null,
          needs_replacement: f.flag("needs_replacement"),
          lead_name: name,
          lead_email,
          lead_phone: f.get("lead_phone", 80, "the phone"),
          current_brokerage: f.get("current_brokerage", 200, "the brokerage"),
          agent_profile_url: f.get("agent_profile_url", 500, "the profile link"),
          introduced_at: date ? date.toISOString() : now(),
          source: "Client Entry",
        };
        if (f.problems.length) return void skipped.push({ row: rowNo(i), reason: f.problems[0] });
        out.push(row);
      });
      if (!out.length) return imported(0, 0, skipped, ["agent", "agents"]);
      const r = await insertAll(db, "client_pipeline_entries", out);
      return r.error ?? imported(r.saved, r.dupes, skipped, ["agent", "agents"]);
    }
    case "agent.import": {
      const have = new Set((await existing<{ email: string | null }>(db, "client_agents", "id, email")).map((x) => (x.email ?? "").toLowerCase()).filter(Boolean));
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("name", 160, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        const row = { client_id: C, name, email: f.email("email"), phone: f.get("phone", 40, "the phone"), license: f.get("license", 80, "the license"), pushed_to_instantly: false, pushed_to_emailbison: false, push_error: null };
        if (f.problems.length) return void skipped.push({ row: rowNo(i), reason: f.problems[0] });
        if (row.email && have.has(row.email)) return void dupes++;
        if (row.email) have.add(row.email);
        out.push(row);
      });
      if (!out.length) return imported(0, dupes, skipped, ["agent", "agents"]);
      const r = await insertAll(db, "client_agents", out);
      return r.error ?? imported(r.saved, dupes + r.dupes, skipped, ["agent", "agents"]);
    }
    case "dnc.import": {
      const have = new Set((await existing<{ kind: string; email: string | null; domain: string | null }>(db, "client_dnc_entries", "id, kind, email, domain")).map((x) => (x.kind === "company" ? `c:${(x.domain ?? "").toLowerCase()}` : `a:${(x.email ?? "").toLowerCase()}`)));
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("name", 160, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        const kind = raw?.kind === "company" ? "company" : "agent";
        const domainText = kind === "company" ? f.get("domain", 255, "the domain") : null;
        const domain = companyDomain(domainText);
        if (domainText && !domain) f.problems.push(`"${domainText.slice(0, 60)}" is not a website domain`);
        const row = {
          client_id: C,
          kind,
          name,
          email: f.email("email"),
          phone: f.get("phone", 40, "the phone"),
          brokerage: kind === "agent" ? f.get("brokerage", 160, "the brokerage") : null,
          domain,
          notes: f.get("notes", 2000, "the notes"),
          added_by: "client",
          pushed_to_instantly: false,
          pushed_to_emailbison: false,
          push_error: null,
        };
        if (f.problems.length) return void skipped.push({ row: rowNo(i), reason: f.problems[0] });
        const key = kind === "company" ? (domain ? `c:${domain}` : null) : row.email ? `a:${row.email}` : null;
        if (key && have.has(key)) return void dupes++;
        if (key) have.add(key);
        out.push(row);
      });
      if (!out.length) return imported(0, dupes, skipped, ["entry", "entries"]);
      const r = await insertAll(db, "client_dnc_entries", out);
      return r.error ?? imported(r.saved, dupes + r.dupes, skipped, ["entry", "entries"]);
    }
    case "team.import": {
      const key = (name: string, email: string) => `${name.trim().toLowerCase()}|${email.trim().toLowerCase()}`;
      const have = new Set((await existing<{ name: string | null; email: string | null }>(db, "client_team_members", "id, name, email")).map((x) => key(x.name ?? "", x.email ?? "")));
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("name", 120, "the name");
        const email = f.email("email");
        const title = f.get("title", 120, "the title");
        const phone = f.get("phone", 40, "the phone");
        if (f.problems.length) return void skipped.push({ row: rowNo(i), reason: f.problems[0] });
        if (!name || !email) return void skipped.push({ row: rowNo(i), reason: "needs a name and an email" });
        // Texts off, as every Demo team member.
        const row = { client_id: C, name, email, title, phone, active: true, receives_sms: false };
        if (have.has(key(row.name, row.email))) return void dupes++;
        have.add(key(row.name, row.email));
        out.push(row);
      });
      if (!out.length) return imported(0, dupes, skipped, ["team member", "team members"]);
      const r = await insertAll(db, "client_team_members", out);
      return r.error ?? imported(r.saved, dupes + r.dupes, skipped, ["team member", "team members"]);
    }
  }
}

// ---------------------------------------------------------- Manage stages ---

/* The live route's structural rules, plus the design's: Introduction and Hired are never hidden. */
function stagesProblem(stages: Array<z.infer<typeof stageRow>>): string | null {
  const keys = new Set<string>();
  const canonical = new Set<string>();
  for (const s of stages) {
    if (keys.has(s.key)) return `"${s.label}" is in the list twice.`;
    keys.add(s.key);
    if (s.color && !HEX.test(s.color) && !(STAGE_COLOR_PALETTE as readonly string[]).includes(s.color)) return `"${s.label}" has a colour that isn't one of the stage colours.`;
    if (s.kind === "canonical") {
      if (!s.canonical_stage || s.key !== s.canonical_stage || !(STAGE_ORDER as string[]).includes(s.key)) return `"${s.label}" is not a pipeline stage.`;
      canonical.add(s.key);
      if ((ALWAYS_SHOWN as string[]).includes(s.key) && s.hidden) return `"${s.label}" is always shown.`;
    } else if (s.canonical_stage || !(CUSTOM_KEY.test(s.key) || (GLOBAL_CUSTOM_STAGE_KEYS as readonly string[]).includes(s.key))) {
      return `"${s.label}" is not a stage this portal can keep.`;
    }
  }
  const missing = STAGE_ORDER.filter((c) => !canonical.has(c));
  return missing.length ? `Every pipeline stage stays — ${missing.join(", ")} is missing.` : null;
}

async function saveStages(db: Db, stages: Array<z.infer<typeof stageRow>>): Promise<DemoResult> {
  const C = DEMO_PORTAL_ID;
  const problem = stagesProblem(stages);
  if (problem) return { ok: false, status: 400, error: problem };
  const have: Res = await db.from("client_pipeline_stages").select("key, kind").eq("client_id", C);
  if (have.error) return failed(have)!;
  const existing = (have.data ?? []) as Array<{ key: string; kind: string }>;
  const wanted = new Set(stages.map((s) => s.key));
  // A custom stage taken out: its agents go back to their pipeline stage first (only the placement is cleared), then it goes.
  const removed = existing.filter((r) => r.kind === "custom" && !wanted.has(r.key)).map((r) => r.key);
  const at = now();
  let moved = 0;
  if (removed.length) {
    const back: Res = await db.from("client_pipeline_entries").update({ custom_stage_key: null, updated_at: at }).eq("client_id", C).in("custom_stage_key", removed).select("id");
    if (back.error) return failed(back)!;
    moved = ((back.data as unknown[]) ?? []).length;
    const gone: Res = await db.from("client_pipeline_stages").delete().eq("client_id", C).in("key", removed);
    if (gone.error) return failed(gone)!;
  }
  const row = (s: z.infer<typeof stageRow>, i: number) => ({
    label: s.label,
    color: s.color ? s.color : null,
    sort_order: i,
    kind: s.kind,
    canonical_stage: s.kind === "canonical" ? s.canonical_stage : null,
    hidden: s.hidden ?? false,
    updated_at: at,
  });
  const known = new Set(existing.map((r) => r.key));
  for (const [i, s] of stages.entries()) {
    if (!known.has(s.key)) continue;
    const r: Res = await db.from("client_pipeline_stages").update(row(s, i)).eq("client_id", C).eq("key", s.key).select("key");
    if (r.error) return failed(r)!;
  }
  const fresh = stages.map((s, i) => ({ s, i })).filter(({ s }) => !known.has(s.key)).map(({ s, i }) => ({ client_id: C, key: s.key, ...row(s, i) }));
  if (fresh.length) {
    const r: Res = await db.from("client_pipeline_stages").insert(fresh).select("key");
    if (r.error) return failed(r)!;
  }
  // Agents on a removed stage or tag are said so; otherwise it is an ordinary save.
  return { ok: true, message: moved ? `Saved. ${plural(moved, "agent", "agents")} moved back to ${moved === 1 ? "its" : "their"} pipeline stage.` : "Saved on the Demo Portal." };
}

/** Runs one save, on the Demo Portal's rows only. `who` is the signed-in person, from the server — never the browser. */
export async function runDemoAction(db: Db, a: DemoAction, who: string | null = null): Promise<DemoResult> {
  const C = DEMO_PORTAL_ID;
  switch (a.type) {
    case "offer.save": {
      // The wizard's "Tell us your offer" (migration 0039): one row per portal — the Demo's.
      const row = { offers: [...new Set(a.offers)], why_join: a.why_join, never_say: a.never_say, updated_by: who, updated_at: now() };
      const had: Res = await db.from("os_portal_offers").select("portal_id").eq("portal_id", C).maybeSingle();
      if (had.error) return failed(had)!;
      const r: Res = had.data
        ? await db.from("os_portal_offers").update(row).eq("portal_id", C).select("portal_id")
        : await db.from("os_portal_offers").insert({ portal_id: C, ...row }).select("portal_id");
      return failed(r) ?? { ok: true, message: "Your offer is saved." };
    }
    case "entry.import":
    case "agent.import":
    case "dnc.import":
    case "team.import":
      return runImport(db, a);
    case "stages.save":
      return saveStages(db, a.stages);
    case "entry.add": {
      // The live portal's manual add; the Demo Portal has pipeline_source_split, so it is a Client Entry.
      const r: Res = await db
        .from("client_pipeline_entries")
        .insert({
          client_id: C,
          stage: a.stage ?? "introduction",
          needs_replacement: false,
          lead_name: a.lead_name,
          lead_email: a.lead_email,
          lead_phone: a.lead_phone,
          current_brokerage: a.current_brokerage,
          agent_profile_url: a.agent_profile_url,
          introduced_at: now(),
          source: "Client Entry",
        })
        .select("id")
        .single();
      return failed(r) ?? { ok: true, id: String((r.data as { id: string }).id) };
    }
    case "entry.stage": {
      // A move clears a custom-stage placement, as the live portal does for manage_stages clients (the Demo Portal is one).
      return (await eachChunk(a.ids, (part) => db.from("client_pipeline_entries").update({ stage: a.stage, custom_stage_key: null, updated_at: now() }).eq("client_id", C).in("id", part).select("id"))) ?? { ok: true };
    }
    case "entry.customStage": {
      if (a.key !== null && !(GLOBAL_CUSTOM_STAGE_KEYS as readonly string[]).includes(a.key)) {
        const st: Res = await db.from("client_pipeline_stages").select("key").eq("client_id", C).eq("kind", "custom").eq("key", a.key).maybeSingle();
        if (st.error) return failed(st)!;
        if (!st.data) return { ok: false, status: 400, error: "That stage no longer exists." };
      }
      return (await eachChunk(a.ids, (part) => db.from("client_pipeline_entries").update({ custom_stage_key: a.key, updated_at: now() }).eq("client_id", C).in("id", part).select("id"))) ?? { ok: true };
    }
    case "entry.assign": {
      if (a.member) {
        const m: Res = await db.from("client_team_members").select("id").eq("client_id", C).eq("id", a.member).maybeSingle();
        if (m.error) return failed(m)!;
        if (!m.data) return { ok: false, status: 404, error: "That team member is not on this portal." };
      }
      return (await eachChunk(a.ids, (part) => db.from("client_pipeline_entries").update({ assigned_team_member_id: a.member, updated_at: now() }).eq("client_id", C).in("id", part).select("id"))) ?? { ok: true };
    }
    case "entry.edit": {
      const r: Res = await db
        .from("client_pipeline_entries")
        .update({ lead_name: a.lead_name, lead_email: a.lead_email, lead_phone: a.lead_phone, current_brokerage: a.current_brokerage, agent_profile_url: a.agent_profile_url, updated_at: now() })
        .eq("client_id", C)
        .eq("id", a.id)
        .select("id");
      if (failed(r)) return failed(r)!;
      return (r.data as unknown[]).length ? { ok: true } : { ok: false, status: 404, error: "That agent is not on this portal." };
    }
    case "entry.fields": {
      const cur: Res = await db.from("client_pipeline_entries").select("custom_fields_overrides").eq("client_id", C).eq("id", a.id).maybeSingle();
      if (failed(cur)) return failed(cur)!;
      if (!cur.data) return { ok: false, status: 404, error: "That agent is not on this portal." };
      const merged: Record<string, unknown> = { ...(((cur.data as { custom_fields_overrides?: Record<string, unknown> | null }).custom_fields_overrides) ?? {}) };
      for (const [key, value] of Object.entries(a.fields)) {
        if (value === null || value === "") delete merged[key];
        else merged[key] = value;
      }
      const r: Res = await db.from("client_pipeline_entries").update({ custom_fields_overrides: merged, updated_at: now() }).eq("client_id", C).eq("id", a.id).select("id");
      return failed(r) ?? { ok: true };
    }
    case "entry.delete": {
      return (await eachChunk(a.ids, (part) => db.from("client_pipeline_entries").delete().eq("client_id", C).in("id", part))) ?? { ok: true };
    }
    case "note.add": {
      // The note's entry must be the Demo Portal's: client_pipeline_notes has no client column of its own.
      const e: Res = await db.from("client_pipeline_entries").select("id").eq("client_id", C).eq("id", a.entry).maybeSingle();
      if (e.error) return failed(e)!;
      if (!e.data) return { ok: false, status: 404, error: "That agent is not on this portal." };
      const r: Res = await db.from("client_pipeline_notes").insert({ entry_id: a.entry, body: a.body }).select("id").single();
      return failed(r) ?? { ok: true, id: String((r.data as { id: string }).id) };
    }
    case "agent.add": {
      // Never pushed to a provider from here: the flags say so.
      const r: Res = await db
        .from("client_agents")
        .insert({ client_id: C, name: a.name, email: a.email, phone: a.phone, license: a.license, pushed_to_instantly: false, pushed_to_emailbison: false, push_error: null })
        .select("id")
        .single();
      return failed(r) ?? { ok: true, id: String((r.data as { id: string }).id) };
    }
    case "agent.edit": {
      const r: Res = await db.from("client_agents").update({ name: a.name, email: a.email, phone: a.phone, license: a.license }).eq("client_id", C).eq("id", a.id).select("id");
      if (failed(r)) return failed(r)!;
      return (r.data as unknown[]).length ? { ok: true } : { ok: false, status: 404, error: "That agent is not on this portal." };
    }
    case "agent.delete": {
      return (await eachChunk(a.ids, (part) => db.from("client_agents").delete().eq("client_id", C).in("id", part))) ?? { ok: true };
    }
    case "dnc.add": {
      const domain = a.kind === "company" ? companyDomain(a.domain) : null;
      if (a.kind === "company" && a.domain && !domain) return { ok: false, status: 400, error: "That doesn't look like a website domain (for example kw.com)." };
      const r: Res = await db
        .from("client_dnc_entries")
        .insert({
          client_id: C,
          kind: a.kind,
          name: a.name,
          email: a.email,
          phone: a.phone,
          brokerage: a.kind === "agent" ? a.brokerage : null,
          domain,
          notes: a.notes,
          added_by: "client",
          pushed_to_instantly: false,
          pushed_to_emailbison: false,
          push_error: null,
        })
        .select("id")
        .single();
      return failed(r) ?? { ok: true, id: String((r.data as { id: string }).id) };
    }
    case "dnc.edit": {
      // The kind never changes (as live); a company's domain is normalised again.
      const cur: Res = await db.from("client_dnc_entries").select("kind").eq("client_id", C).eq("id", a.id).maybeSingle();
      if (cur.error) return failed(cur)!;
      if (!cur.data) return { ok: false, status: 404, error: "That entry is not on this portal." };
      const company = (cur.data as { kind: string }).kind === "company";
      const domain = company ? companyDomain(a.domain) : null;
      if (company && a.domain && !domain) return { ok: false, status: 400, error: "That doesn't look like a website domain (for example kw.com)." };
      const r: Res = await db
        .from("client_dnc_entries")
        // An agent entry's domain is left as it is (it is not a block, and the form doesn't show it).
        // A company's form has no email or phone: they are kept as they are (22 Oct audit: an edit erased them).
        .update({ name: a.name, ...(company ? { domain } : { email: a.email, phone: a.phone, brokerage: a.brokerage }), notes: a.notes })
        .eq("client_id", C)
        .eq("id", a.id)
        .select("id");
      return failed(r) ?? { ok: true };
    }
    case "dnc.delete": {
      return (await eachChunk(a.ids, (part) => db.from("client_dnc_entries").delete().eq("client_id", C).in("id", part))) ?? { ok: true };
    }
    case "team.add": {
      // An exact name + email repeat is refused, as live.
      const dupes: Res = await db.from("client_team_members").select("id, name").eq("client_id", C).eq("email", a.email);
      if (dupes.error) return failed(dupes)!;
      if (((dupes.data ?? []) as Array<{ name: string | null }>).some((d) => (d.name ?? "").trim().toLowerCase() === a.name.toLowerCase())) {
        return { ok: false, status: 409, error: "This person is already on the team." };
      }
      // Texts off: a phone number added to the Demo Portal is never texted.
      const r: Res = await db
        .from("client_team_members")
        .insert({ client_id: C, name: a.name, email: a.email, title: a.title, phone: a.phone, active: true, receives_sms: false })
        .select("id")
        .single();
      return failed(r) ?? { ok: true, id: String((r.data as { id: string }).id) };
    }
    case "team.edit": {
      // Texts off on every Demo save, not only on add (22 Oct audit): a member made before 0077 defaulted to on.
      const r: Res = await db.from("client_team_members").update({ name: a.name, email: a.email, title: a.title, phone: a.phone, receives_sms: false }).eq("client_id", C).eq("id", a.id).select("id");
      if (failed(r)) return failed(r)!;
      return (r.data as unknown[]).length ? { ok: true } : { ok: false, status: 404, error: "That person is not on this portal's team." };
    }
    case "team.active": {
      const r: Res = await db.from("client_team_members").update({ active: a.active, receives_sms: false }).eq("client_id", C).eq("id", a.id).select("id");
      return failed(r) ?? { ok: true };
    }
    case "team.delete": {
      // Their agents become unassigned by the database itself (0043: on delete set null), as live.
      return (await eachChunk(a.ids, (part) => db.from("client_team_members").delete().eq("client_id", C).in("id", part))) ?? { ok: true };
    }
  }
}

/* ----------------------------------------------------- Market's Move to (23 Oct) --- */

/**
 * Moves agents of the agent database between the Demo Portal's lists.
 * `onlyUnlisted` (the Setup wizard's prospects step: "My Agents and your DNC
 * List are always left out") leaves alone anyone already on My Agents, the DNC
 * List (as a person or by company domain) or in the pipeline.
 */
export async function moveAgents(db: Db, ids: readonly string[], to: MoveTarget, who: string | null, opts: { onlyUnlisted?: boolean } = {}): Promise<DemoResult> {
  const C = DEMO_PORTAL_ID;
  const unique = [...new Set(ids)];
  // Before anything is taken off a list: Prospects must exist when it is where they go.
  if (to === "Prospects" && (await demoProspectIds(db, C)) === null) return { ok: false, status: 409, error: PROSPECTS_MIGRATION };
  let agents = await agentsByIds(unique);
  if (!agents.length) return { ok: false, status: 404, error: "Those agents are not in the agent database." };
  if (opts.onlyUnlisted) {
    const [my, dn, pl] = await Promise.all([
      db.from("client_agents").select("name, email").eq("client_id", C) as PromiseLike<Res>,
      db.from("client_dnc_entries").select("kind, name, email, domain").eq("client_id", C) as PromiseLike<Res>,
      db.from("client_pipeline_entries").select("lead_name, lead_email").eq("client_id", C) as PromiseLike<Res>,
    ]);
    const bad = [my, dn, pl].find((r) => r.error);
    if (bad) return failed(bad)!;
    const people = [
      ...((my.data ?? []) as Array<{ name: string | null; email: string | null }>),
      ...((dn.data ?? []) as Array<{ kind: string; name: string | null; email: string | null }>).filter((d) => d.kind === "agent"),
      ...((pl.data ?? []) as Array<{ lead_name: string | null; lead_email: string | null }>).map((x) => ({ name: x.lead_name, email: x.lead_email })),
    ];
    const listedEmails = new Set(people.map((x) => lower(x.email)).filter(Boolean));
    const listedNames = new Set(people.filter((x) => !lower(x.email)).map((x) => personKey(x.name)).filter((k) => k.length >= 5));
    const domains = new Set(((dn.data ?? []) as Array<{ kind: string; domain: string | null }>).filter((d) => d.kind === "company").map((d) => lower(d.domain).replace(/^@/, "")).filter(Boolean));
    agents = agents.filter((a) => {
      const es = emailsOf(a);
      return !es.some((e) => listedEmails.has(e) || domains.has(e.split("@")[1] ?? "")) && !listedNames.has(personKey(a.full_name));
    });
    if (!agents.length) return { ok: true, message: "They're all on My Agents, your DNC List or your pipeline already — left out, as always." };
  }
  const emails = new Set(agents.flatMap(emailsOf));
  const names = new Set(agents.map((a) => personKey(a.full_name)).filter((k) => k.length >= 5));
  // A list entry is this agent's by an address, or — an entry with no address — by name (market-model listFor).
  const theirs = (row: { email: string | null; name: string | null }) => (lower(row.email) ? emails.has(lower(row.email)) : names.has(personKey(row.name)));

  const [mine, dnc] = await Promise.all([
    db.from("client_agents").select("id, name, email").eq("client_id", C) as PromiseLike<Res>,
    db.from("client_dnc_entries").select("id, name, email, kind").eq("client_id", C).eq("kind", "agent") as PromiseLike<Res>,
  ]);
  if (mine.error || dnc.error) return failed(mine.error ? mine : dnc)!;
  const myRows = ((mine.data ?? []) as Array<{ id: string; name: string | null; email: string | null }>).filter(theirs);
  const dncRows = ((dnc.data ?? []) as Array<{ id: string; name: string | null; email: string | null }>).filter(theirs);

  // Off the lists it is leaving.
  if (to !== "My Agents" && myRows.length) {
    const r = await eachChunk(myRows.map((x) => x.id), (part) => db.from("client_agents").delete().eq("client_id", C).in("id", part));
    if (r) return r;
  }
  if (to !== "DNC List" && dncRows.length) {
    const r = await eachChunk(dncRows.map((x) => x.id), (part) => db.from("client_dnc_entries").delete().eq("client_id", C).in("id", part));
    if (r) return r;
  }
  if (to !== "Prospects") {
    const r: Res = await db.from("os_demo_prospects").delete().eq("portal_id", C).in("agent_id", agents.map((a) => a.id));
    if (r.error && !missingTable(r)) return failed(r)!;
  }

  // Onto the one it goes to — those not on it already. By name, brokerage and phone: never the agent database's email.
  const already = (rows: Array<{ name: string | null; email: string | null }>, a: AgentRow) =>
    rows.some((row) => (lower(row.email) ? emailsOf(a).includes(lower(row.email)) : personKey(row.name) === personKey(a.full_name) && personKey(a.full_name).length >= 5));
  const adding = agents.filter((a) => (to === "My Agents" ? !already(myRows, a) : to === "DNC List" ? !already(dncRows, a) : true));
  if (to === "My Agents" && adding.length) {
    const r: Res = await db.from("client_agents").insert(adding.map((a) => ({
      client_id: C, name: a.full_name ?? "Unnamed agent", email: null, phone: a.preferred_phone, license: null, notes: "From Market",
      pushed_to_instantly: false, pushed_to_emailbison: false, push_error: null,
    })));
    if (r.error) return failed(r)!;
  } else if (to === "DNC List" && adding.length) {
    const r: Res = await db.from("client_dnc_entries").insert(adding.map((a) => ({
      client_id: C, kind: "agent", name: a.full_name ?? "Unnamed agent", email: null, phone: a.preferred_phone, brokerage: a.brand ?? a.office_name,
      domain: null, notes: "From Market", added_by: "client", pushed_to_instantly: false, pushed_to_emailbison: false, push_error: null,
    })));
    if (r.error) return failed(r)!;
  } else if (to === "Prospects") {
    // Only those not on it yet: a plain insert, never an upsert (the preview's writes never overwrite).
    const have = new Set((await demoProspectIds(db, C)) ?? []);
    const fresh = agents.filter((a) => !have.has(a.id));
    if (fresh.length) {
      const r: Res = await db.from("os_demo_prospects").insert(fresh.map((a) => ({ portal_id: C, agent_id: a.id, added_by: who })));
      if (missingTable(r)) return { ok: false, status: 409, error: PROSPECTS_MIGRATION };
      if (r.error) return failed(r)!;
    }
  }
  const n = agents.length;
  const who1 = n === 1 ? (agents[0].full_name ?? "1 agent") : `${n.toLocaleString("en-US")} agents`;
  return { ok: true, message: to === "Not on a list" ? `${who1} taken off every list.` : `${who1} moved to ${to}.` };
}
