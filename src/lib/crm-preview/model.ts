/*
 * The CRM redesign preview's view of a client's pipeline — pure, so the
 * server page, the client screens and the tests share one definition.
 *
 * It reads a client's pipeline exactly as their portal holds it today and
 * only changes how it is SHOWN, the way the client's design asks:
 *
 *   - Stages that move forward are board columns: Introduction (or the
 *     client's own name for it), Phone Screen Scheduled, Phone Screen,
 *     Interview Scheduled (where the client has it), Interview, Hired.
 *   - Nurture, Not a Fit and No Response are TAGS in the design, shown under
 *     the agent's name and as filter chips. Today they are stages, so an agent
 *     in one has no forward stage. Eddy approved (16 Oct) that such an agent
 *     stays at the FURTHEST forward stage they reached before being tagged —
 *     from the stage history the portal keeps (pipeline_outcome_events, since
 *     3 Aug); with no history, the first stage. The preview places them so,
 *     tag under the name. Nothing is moved: it is read, not written.
 *   - Labels, hidden stages and the Demo portal's own stages come from the
 *     same settings the live portal uses (stage-config.ts).
 *
 * Dates are read in US Eastern time so the server and the browser draw the
 * same day.
 */

import type { PipelineEntry, PipelineStage } from "@/lib/tools/master-inbox/portals/stages-shared";
import { GLOBAL_CUSTOM_STAGE_KEYS, type StageDef } from "@/lib/tools/master-inbox/portals/stage-config";
import { CLIENT_ENTRY_SOURCE } from "@/lib/tools/master-inbox/portals/intro-counts";
import { formatPortalFieldValue } from "@/components/master-inbox/portals-ui/custom-field-helpers";

export const PREVIEW_TZ = "America/New_York";

/** The design's sidebar pages, as `?view=` names them. Billing is a link out, so not one. */
export const PREVIEW_VIEWS = ["pipeline", "reports", "campaigns", "market", "prospects", "agents", "dnc", "team", "integrations", "help"] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

export type PillTone = "int" | "ph" | "iv" | "hi" | "nu" | "no" | "nr";

export interface PreviewStage {
  key: string;
  label: string;
  role: "stage" | "tag";
  dot: string;
  pill: PillTone;
}

// The design's colours (the handoff's board, move menu and Manage stages screens).
const DESIGN: Record<PipelineStage, { dot: string; pill: PillTone; tag: boolean }> = {
  introduction: { dot: "#3e6bd1", pill: "int", tag: false },
  phone_screen_scheduled: { dot: "#d68a00", pill: "ph", tag: false },
  phone_screen: { dot: "#d68a00", pill: "ph", tag: false },
  interview_scheduled: { dot: "#6e56cf", pill: "iv", tag: false },
  interview: { dot: "#6e56cf", pill: "iv", tag: false },
  hired: { dot: "#1a9a47", pill: "hi", tag: false },
  keep_warm: { dot: "#0f766e", pill: "nu", tag: true },
  we_they_rejected: { dot: "#b42318", pill: "no", tag: true },
  no_show: { dot: "#6b7280", pill: "nr", tag: true },
};
const NO_SHOW_TAG = { dot: "#9a5b00", pill: "nr" as const };

/** The client's visible stages, in their order, each marked as a design stage or tag. */
export function previewStages(defs: readonly StageDef[]): PreviewStage[] {
  return defs
    .filter((d) => !d.hidden)
    .map((d): PreviewStage => {
      if (d.canonicalStage) {
        const s = DESIGN[d.canonicalStage];
        return { key: d.key, label: d.label, role: s.tag ? "tag" : "stage", dot: s.dot, pill: s.pill };
      }
      if ((GLOBAL_CUSTOM_STAGE_KEYS as readonly string[]).includes(d.key)) {
        return { key: d.key, label: d.label, role: "tag", ...NO_SHOW_TAG };
      }
      return { key: d.key, label: d.label, role: "stage", dot: d.color, pill: "nu" };
    });
}

/** Where an entry sits: its Demo-only custom stage if set, else its stage (as the live board reads it). */
export function stageKeyOf(e: Pick<PipelineEntry, "custom_stage_key" | "stage">): string {
  return e.custom_stage_key ?? e.stage;
}

// ----------------------------------------------- tagged agents' stage ---

/** The forward stages in the order they are reached (the stage history's vocabulary). */
const FORWARD: readonly PipelineStage[] = ["introduction", "phone_screen_scheduled", "phone_screen", "interview_scheduled", "interview", "hired"];

/**
 * For each tagged agent, the furthest forward stage their history records
 * (pipeline_outcome_events.event_type is a pipeline_stage value).
 */
export function furthestStages(
  events: ReadonlyArray<{ entry_id: string | null; event_type: string }>,
  taggedIds: ReadonlySet<string>,
): Record<string, PipelineStage> {
  const out: Record<string, PipelineStage> = {};
  for (const ev of events) {
    if (!ev.entry_id || !taggedIds.has(ev.entry_id)) continue;
    const rank = FORWARD.indexOf(ev.event_type as PipelineStage);
    if (rank < 0) continue;
    const had = out[ev.entry_id];
    if (had === undefined || FORWARD.indexOf(had) < rank) out[ev.entry_id] = FORWARD[rank];
  }
  return out;
}

export interface Placement {
  /** The board column: a forward stage. */
  stage: PreviewStage;
  /** The tag, for an agent in Nurture / Not a Fit / No Response today. */
  tag: PreviewStage | null;
  /** True when the stage came from the history rather than the agent's own stage. */
  fromHistory: boolean;
}

/**
 * Where an entry sits on the redesign's board. A tagged agent goes to the
 * furthest stage recorded for them — or, when the client does not show that
 * stage (Interview Scheduled is Demo-only), the nearest earlier one it does —
 * else the first stage.
 */
export function placeEntry(e: Pick<PipelineEntry, "id" | "custom_stage_key" | "stage">, stages: readonly PreviewStage[], furthest: Readonly<Record<string, string>>): Placement | null {
  const own = stages.find((s) => s.key === stageKeyOf(e));
  if (!own) return null;
  if (own.role === "stage") return { stage: own, tag: null, fromHistory: false };
  const forward = stages.filter((s) => s.role === "stage");
  if (!forward.length) return null;
  const reached = furthest[e.id];
  const rank = reached ? FORWARD.indexOf(reached as PipelineStage) : -1;
  for (let r = rank; r >= 0; r -= 1) {
    const hit = forward.find((s) => s.key === FORWARD[r]);
    if (hit) return { stage: hit, tag: own, fromHistory: true };
  }
  return { stage: forward[0], tag: own, fromHistory: false };
}

// ----------------------------------------------------------------- dates ---

export type TimeRange = "week" | "month" | "3m" | "12m" | "all";

export const TIME_RANGES: ReadonlyArray<{ id: TimeRange; label: string }> = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "3m", label: "Last 3 months" },
  { id: "12m", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone: PREVIEW_TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });

function eastern(d: Date): { y: number; m: number; day: number; weekday: string } {
  const p = Object.fromEntries(dayParts.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day), weekday: p.weekday };
}

const key = (y: number, m: number, day: number) => {
  const d = new Date(Date.UTC(y, m - 1, day));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

function dayKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const e = eastern(d);
  return key(e.y, e.m, e.day);
}

const WEEKDAY_FROM_MONDAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The first day a range includes (Eastern), or null for All time. Weeks start on Monday. */
export function rangeStart(range: TimeRange, now: Date): string | null {
  const n = eastern(now);
  switch (range) {
    case "week": return key(n.y, n.m, n.day - (WEEKDAY_FROM_MONDAY[n.weekday] ?? 0));
    case "month": return key(n.y, n.m, 1);
    case "3m": return key(n.y, n.m - 3, n.day);
    case "12m": return key(n.y - 1, n.m, n.day);
    default: return null;
  }
}

export function inRange(iso: string | null, range: TimeRange, now: Date): boolean {
  const start = rangeStart(range, now);
  if (start === null) return true;
  const k = iso ? dayKey(iso) : null;
  return k !== null && k >= start;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: PREVIEW_TZ, ...opts });
const SHORT = fmt({ month: "short", day: "numeric" });
const SHORT_YEAR = fmt({ month: "short", day: "numeric", year: "numeric" });
const LONG = fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
const STAMP = fmt({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const MONTH = fmt({ month: "long", year: "numeric" });

const valid = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "Oct 5", or "Oct 5, 2025" when it is not this year. */
export function shortDate(iso: string | null, now: Date): string {
  const d = valid(iso);
  if (!d) return "—";
  return eastern(d).y === eastern(now).y ? SHORT.format(d) : SHORT_YEAR.format(d);
}
export const longDate = (iso: string | null) => { const d = valid(iso); return d ? LONG.format(d) : "—"; };
export const stamp = (iso: string | null) => { const d = valid(iso); return d ? STAMP.format(d) : ""; };

// ---------------------------------------------------------------- money ---

/** Sales volume from the merged custom fields, as the live board reads it (pipeline-kanban.tsx). */
export function salesVolumeOf(entry: Pick<PipelineEntry, "lead_detail">): number | null {
  const cf = (entry.lead_detail as { custom_fields?: Record<string, unknown> } | null)?.custom_fields;
  if (!cf) return null;
  for (const [k, v] of Object.entries(cf)) {
    if (/sales\s*volume/i.test(k)) {
      const n = Number(String(v).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/** $45.2M, $980K, $1.2B — the live board's abbreviation. */
export function abbrevUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${Math.round(n)}`;
}

// ----------------------------------------------------------------- views ---

export interface PipelineFilter {
  range: TimeRange;
  search: string;
  /** A stage or tag chip, or null for none. */
  chip: string | null;
  now: Date;
}

export function matchesSearch(e: Pick<PipelineEntry, "lead_name" | "lead_email" | "current_brokerage" | "lead_phone">, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [e.lead_name, e.lead_email, e.current_brokerage, e.lead_phone].some((v) => (v ?? "").toLowerCase().includes(q));
}

export interface BoardColumn {
  stage: PreviewStage;
  entries: PipelineEntry[];
  volume: number;
}

export interface PipelineView {
  /** Per stage: agents at it (tagged ones included); per tag: agents with it — within the time range and search. */
  counts: Map<string, number>;
  /** The agents the page lists: the above, narrowed to the picked chip. */
  shown: PipelineEntry[];
  totalVolume: number;
  /** The board: the forward stages — or just the picked stage's. */
  columns: BoardColumn[];
  /** Where each listed agent sits. */
  placement: Map<string, Placement>;
}

export function pipelineView(entries: readonly PipelineEntry[], stages: readonly PreviewStage[], f: PipelineFilter, furthest: Readonly<Record<string, string>> = {}): PipelineView {
  const known = new Map(stages.map((s) => [s.key, s]));
  const placement = new Map<string, Placement>();
  for (const e of entries) {
    const p = placeEntry(e, stages, furthest);
    if (p) placement.set(e.id, p);
  }
  const matching = entries.filter((e) => placement.has(e.id) && inRange(e.introduced_at, f.range, f.now) && matchesSearch(e, f.search));
  const counts = new Map<string, number>(stages.map((s) => [s.key, 0]));
  for (const e of matching) {
    const p = placement.get(e.id)!;
    counts.set(p.stage.key, (counts.get(p.stage.key) ?? 0) + 1);
    if (p.tag) counts.set(p.tag.key, (counts.get(p.tag.key) ?? 0) + 1);
  }

  const chip = f.chip && known.has(f.chip) ? known.get(f.chip)! : null;
  const shown = !chip ? matching : matching.filter((e) => {
    const p = placement.get(e.id)!;
    return chip.role === "tag" ? p.tag?.key === chip.key : p.stage.key === chip.key;
  });
  const totalVolume = shown.reduce((sum, e) => sum + (salesVolumeOf(e) ?? 0), 0);

  // A tag chip keeps every column and shows only that tag's agents in them; a stage chip shows its column.
  const columnStages = chip && chip.role === "stage" ? [chip] : stages.filter((s) => s.role === "stage");
  const columns = columnStages.map((stage) => {
    const col = shown.filter((e) => placement.get(e.id)!.stage.key === stage.key);
    return { stage, entries: col, volume: col.reduce((sum, e) => sum + (salesVolumeOf(e) ?? 0), 0) };
  });
  return { counts, shown, totalVolume, columns, placement };
}

export interface MonthGroup {
  key: string;
  label: string;
  entries: PipelineEntry[];
}

/** The list view: newest month first, newest agent first within it; undated agents last. */
export function groupByMonth(entries: readonly PipelineEntry[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>();
  for (const e of entries) {
    const d = valid(e.introduced_at);
    const k = d ? (dayKey(e.introduced_at!) ?? "").slice(0, 7) : "none";
    const g = groups.get(k) ?? { key: k, label: d ? MONTH.format(d) : "No date", entries: [] };
    g.entries.push(e);
    groups.set(k, g);
  }
  const time = (e: PipelineEntry) => valid(e.introduced_at)?.getTime() ?? 0;
  return [...groups.values()]
    .map((g) => ({ ...g, entries: [...g.entries].sort((a, b) => time(b) - time(a)) }))
    .sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : b.key.localeCompare(a.key)));
}

// ---------------------------------------------------------- conversation ---

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// Where the quoted history starts in a reply's HTML: Gmail's quote block, any
// blockquote, Outlook's reply header.
const HTML_QUOTE = /<blockquote|<div[^>]*class="[^"]*gmail_quote|<div[^>]*id="(divRplyFwdMsg|appendonsend)"/i;

function htmlToText(html: string): string {
  const at = html.search(HTML_QUOTE);
  const own = at > 0 ? html.slice(0, at) : html;
  return decodeEntities(
    own
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/(div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

/*
 * An email as plain text for the read-only thread, without the quoted history
 * under a reply (each earlier message is shown on its own). Rendered as text,
 * never as HTML.
 *
 * The HTML part is read first: in this mailbox the text part of our own emails
 * has its line breaks dropped and its "<" escaped, so paragraphs and the
 * "On … wrote:" line would run together. The text part is the fallback.
 */
export function messageText(text: string | null, html: string | null): string {
  let s = (html && html.trim() ? htmlToText(html) : decodeEntities(text ?? "")).replace(/\r\n?/g, "\n");
  const cuts = [
    /^\s*On [^\n]{0,200}?(\n[^\n]{0,200}?)?wrote:\s*$/m,
    /\bOn (Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? [^\n]{5,200}?wrote:/,
    /^\s*-{2,}\s*Original Message\s*-{2,}/im,
    /^\s*From: [^\n]+\n\s*(Sent|Date): /m,
  ];
  for (const re of cuts) {
    const at = s.search(re);
    if (at > 0) s = s.slice(0, at);
  }
  s = s.split("\n").filter((line) => !/^\s*>/.test(line)).join("\n");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --------------------------------------------------------------- display ---

export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
  if (words.length === 0) return "?";
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

/** The design's source tag: "Client" for agents the client added, else "BrokerStaffer". */
export function sourceLabel(e: Pick<PipelineEntry, "source">): "Client" | "BrokerStaffer" {
  return e.source === CLIENT_ENTRY_SOURCE ? "Client" : "BrokerStaffer";
}

// Shown in their own rows of the panel already, so not repeated from the custom fields.
const PANEL_SKIP = new Set(["email", "emailaddress", "phone", "phonenumber", "mobile", "cell", "name", "fullname", "firstname", "lastname", "company", "companyname", "brokerage", "currentbrokerage"]);

function fieldLabel(k: string): string {
  if (/[\s-]/.test(k)) return k.trim();
  const words = k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface PanelField {
  label: string;
  value: string;
  /** Set when the value is a web address, to show it as a link. */
  href?: string;
}

/** The agent panel's rows from the lead's details, in the order the portal holds them. */
export function panelFields(e: Pick<PipelineEntry, "lead_detail">): PanelField[] {
  const cf = (e.lead_detail as { custom_fields?: Record<string, unknown> } | null)?.custom_fields ?? {};
  const out: PanelField[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(cf)) {
    const norm = k.toLowerCase().replace(/[^a-z]/g, "");
    if (!norm || PANEL_SKIP.has(norm) || seen.has(norm)) continue;
    if (v == null || typeof v === "object") continue;
    const value = formatPortalFieldValue(k, v);
    if (!value || value === "null" || value === "undefined") continue;
    seen.add(norm);
    out.push(/^https?:\/\//i.test(value) ? { label: fieldLabel(k), value, href: value } : { label: fieldLabel(k), value });
  }
  return out;
}

/** A US phone number as the design writes it — (678) 884-4475 — or as it came when it is not one. */
export function formatPhone(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : s;
}

// ------------------------------------------------------------ list pages ---

export const LIST_PAGE_SIZE = 50;
/** Each month opens with this many agents, then "Show N more from <month>" (the design's list). */
export const ROWS_PER_MONTH = 3;

export interface ListPage {
  page: number;
  pages: number;
  from: number;
  to: number;
  total: number;
  /** The months on this page; `monthTotal` is the whole month, as the design's group line counts it. */
  groups: Array<{ key: string; label: string; monthTotal: number; rows: PipelineEntry[] }>;
}

/** One page of the list view: 50 agents, newest first, in their months. */
export function listPage(entries: readonly PipelineEntry[], page: number): ListPage {
  const months = groupByMonth(entries);
  const flat = months.flatMap((g) => g.entries.map((e) => ({ g, e })));
  const total = flat.length;
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const groups: ListPage["groups"] = [];
  for (const { g, e } of flat.slice((p - 1) * LIST_PAGE_SIZE, p * LIST_PAGE_SIZE)) {
    const last = groups[groups.length - 1];
    if (!last || last.key !== g.key) groups.push({ key: g.key, label: g.label, monthTotal: g.entries.length, rows: [e] });
    else last.rows.push(e);
  }
  return { page: p, pages, from: total ? (p - 1) * LIST_PAGE_SIZE + 1 : 0, to: Math.min(p * LIST_PAGE_SIZE, total), total, groups };
}
