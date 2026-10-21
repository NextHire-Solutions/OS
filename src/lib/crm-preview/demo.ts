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
 */

import { z } from "zod";

import { fetchAllRows } from "@/lib/tools/master-inbox/db/paginated-select";
import { STAGE_ORDER, type PipelineStage } from "@/lib/tools/master-inbox/portals/stages-shared";
import { GLOBAL_CUSTOM_STAGE_KEYS } from "@/lib/tools/master-inbox/portals/stage-config";

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
const ids = z.array(id).min(1).max(500);
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

/** Every save the Demo Portal can make — what its screens' buttons do. */
export const demoAction = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("entry.import"), rows: csvRows }),
  z.object({ type: z.literal("agent.import"), rows: csvRows }),
  z.object({ type: z.literal("dnc.import"), rows: csvRows }),
  z.object({ type: z.literal("team.import"), rows: csvRows }),
]);

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
type Db = { from(table: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any

type Res = { data: unknown; error: { message: string } | null };
const failed = (r: Res): DemoResult | null => (r.error ? { ok: false, status: 400, error: "That could not be saved. Please try again." } : null);
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

/* A stage as a file may write it: the key ("phone_screen") or its name ("Phone Screen", "We/They Rejected"). */
function stageFromCsv(raw: string): PipelineStage | null {
  const key = raw.trim().toLowerCase().replace(/[\s/-]+/g, "_");
  return (STAGE_ORDER as string[]).includes(key) ? (key as PipelineStage) : null;
}

/* The spreadsheet's own row number: the header is row 1. */
const rowNo = (i: number) => i + 2;
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
async function insertAll(db: Db, table: string, rows: Array<Record<string, unknown>>): Promise<{ saved: number; error?: DemoResult }> {
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r: Res = await db.from(table).insert(rows.slice(i, i + 500)).select("id");
    if (r.error) return { saved, error: { ok: false, status: 400, error: saved ? `${plural(saved, "row was", "rows were")} saved, then the rest could not be. Please try again.` : "That file could not be saved. Please try again." } };
    saved += ((r.data as unknown[]) ?? []).length;
  }
  return { saved };
}

/* The Demo Portal's existing rows of a list, every page of them. */
const existing = <T,>(db: Db, table: string, columns: string) =>
  fetchAllRows<T>(({ from, to }) => db.from(table).select(columns).eq("client_id", DEMO_PORTAL_ID).order("id").range(from, to));

async function runImport(db: Db, a: Extract<DemoAction, { rows: unknown }>): Promise<DemoResult> {
  const C = DEMO_PORTAL_ID;
  const skipped: Skip[] = [];
  const out: Array<Record<string, unknown>> = [];
  let dupes = 0;
  switch (a.type) {
    case "entry.import": {
      a.rows.forEach((raw, i) => {
        const f = rowReader(raw);
        const name = f.get("lead_name", 200, "the name");
        if (!name) return void skipped.push({ row: rowNo(i), reason: "no name" });
        const lead_email = f.email("lead_email");
        const stageText = f.get("stage", 64, "the stage");
        const stage = stageText ? stageFromCsv(stageText) : "introduction";
        if (!stage) f.problems.push(`"${stageText!.slice(0, 40)}" is not a pipeline stage`);
        const dateText = f.get("introduced_at", 64, "the date");
        const date = dateText ? new Date(dateText) : null;
        if (date && Number.isNaN(date.getTime())) f.problems.push(`"${dateText}" is not a date`);
        const row = {
          client_id: C,
          stage,
          needs_replacement: f.flag("needs_replacement"),
          lead_name: name,
          lead_email,
          lead_phone: f.get("lead_phone", 80, "the phone"),
          current_brokerage: f.get("current_brokerage", 200, "the brokerage"),
          agent_profile_url: f.get("agent_profile_url", 500, "the profile link"),
          introduced_at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : now(),
          source: "Client Entry",
        };
        if (f.problems.length) return void skipped.push({ row: rowNo(i), reason: f.problems[0] });
        out.push(row);
      });
      if (!out.length) return imported(0, 0, skipped, ["agent", "agents"]);
      const r = await insertAll(db, "client_pipeline_entries", out);
      return r.error ?? imported(r.saved, 0, skipped, ["agent", "agents"]);
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
      return r.error ?? imported(r.saved, dupes, skipped, ["agent", "agents"]);
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
      return r.error ?? imported(r.saved, dupes, skipped, ["entry", "entries"]);
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
      return r.error ?? imported(r.saved, dupes, skipped, ["team member", "team members"]);
    }
  }
}

/** Runs one save, on the Demo Portal's rows only. */
export async function runDemoAction(db: Db, a: DemoAction): Promise<DemoResult> {
  const C = DEMO_PORTAL_ID;
  switch (a.type) {
    case "entry.import":
    case "agent.import":
    case "dnc.import":
    case "team.import":
      return runImport(db, a);
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
      const r: Res = await db.from("client_pipeline_entries").update({ stage: a.stage, custom_stage_key: null, updated_at: now() }).eq("client_id", C).in("id", a.ids).select("id");
      return failed(r) ?? { ok: true };
    }
    case "entry.customStage": {
      if (a.key !== null && !(GLOBAL_CUSTOM_STAGE_KEYS as readonly string[]).includes(a.key)) {
        const st: Res = await db.from("client_pipeline_stages").select("key").eq("client_id", C).eq("kind", "custom").eq("key", a.key).maybeSingle();
        if (st.error) return failed(st)!;
        if (!st.data) return { ok: false, status: 400, error: "That stage no longer exists." };
      }
      const r: Res = await db.from("client_pipeline_entries").update({ custom_stage_key: a.key, updated_at: now() }).eq("client_id", C).in("id", a.ids).select("id");
      return failed(r) ?? { ok: true };
    }
    case "entry.assign": {
      if (a.member) {
        const m: Res = await db.from("client_team_members").select("id").eq("client_id", C).eq("id", a.member).maybeSingle();
        if (m.error) return failed(m)!;
        if (!m.data) return { ok: false, status: 404, error: "That team member is not on this portal." };
      }
      const r: Res = await db.from("client_pipeline_entries").update({ assigned_team_member_id: a.member, updated_at: now() }).eq("client_id", C).in("id", a.ids).select("id");
      return failed(r) ?? { ok: true };
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
    case "entry.delete": {
      const r: Res = await db.from("client_pipeline_entries").delete().eq("client_id", C).in("id", a.ids);
      return failed(r) ?? { ok: true };
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
      const r: Res = await db.from("client_agents").delete().eq("client_id", C).in("id", a.ids);
      return failed(r) ?? { ok: true };
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
        .update({ name: a.name, email: a.email, phone: a.phone, brokerage: company ? null : a.brokerage, ...(company ? { domain } : {}), notes: a.notes })
        .eq("client_id", C)
        .eq("id", a.id)
        .select("id");
      return failed(r) ?? { ok: true };
    }
    case "dnc.delete": {
      const r: Res = await db.from("client_dnc_entries").delete().eq("client_id", C).in("id", a.ids);
      return failed(r) ?? { ok: true };
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
      const r: Res = await db.from("client_team_members").update({ name: a.name, email: a.email, title: a.title, phone: a.phone }).eq("client_id", C).eq("id", a.id).select("id");
      if (failed(r)) return failed(r)!;
      return (r.data as unknown[]).length ? { ok: true } : { ok: false, status: 404, error: "That person is not on this portal's team." };
    }
    case "team.active": {
      const r: Res = await db.from("client_team_members").update({ active: a.active }).eq("client_id", C).eq("id", a.id).select("id");
      return failed(r) ?? { ok: true };
    }
    case "team.delete": {
      // Their agents become unassigned by the database itself (0043: on delete set null), as live.
      const r: Res = await db.from("client_team_members").delete().eq("client_id", C).in("id", a.ids);
      return failed(r) ?? { ok: true };
    }
  }
}
