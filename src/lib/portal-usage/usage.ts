/*
 * How much each person, and each client, reads from the new portal — counted
 * in the database (21 Oct; migration 0038) — and our team TOLD when it looks
 * like copying. The user, 21 Oct: "we should not pause any funtionality in
 * the client portal. just alert in OS should work". So nothing here refuses,
 * pauses or slows a client: it only rings the OS bell (admins).
 *
 *   - "Heavy use today": a person, or a whole portal (all its people
 *     together), passes the day's usual amount of a kind — agents viewed in
 *     Market/Prospects, reports, chat messages, billing pages, conversations.
 *     Once a day for each.
 *   - "Looks automated": someone pages through Market faster than a person
 *     reads (25 pages inside 5 minutes). Once a day per person.
 *   - Our own team (the preview's reviewers) is counted, never alerted on.
 *
 * Counts that cannot be written are logged and skipped — never in a client's way.
 */

export type UsageRole = "staff" | "client";
export type UsageKind = "market" | "report" | "chat" | "billing" | "conversation";

type Level = { requests?: number; rows?: number };
/** The day's usual amount for a client; past it, our team hears once. Nothing is refused. */
export const HEAVY_USE: Record<UsageKind, { person: Level; portal: Level }> = {
  market: { person: { rows: 2_000 }, portal: { rows: 5_000 } },
  report: { person: { requests: 20 }, portal: { requests: 50 } },
  chat: { person: { requests: 60 }, portal: { requests: 150 } },
  billing: { person: { requests: 10 }, portal: { requests: 20 } },
  conversation: { person: { requests: 500 }, portal: { requests: 1_500 } },
};

/** Paging this fast through Market is a script, not a person reading: 25 pages inside 5 minutes. */
export const PAGING_PAGES = 25;
export const PAGING_WINDOW_MS = 5 * 60_000;

type Db = { from(table: string): any; rpc(fn: string, args: Record<string, unknown>): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Res = { data: unknown; error: { message: string } | null };
type Totals = { requests: number; rows: number };

const day = (now: Date) => now.toISOString().slice(0, 10);
const norm = (e: string) => e.trim().toLowerCase();
const fail = (r: Res, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); };
const past = (level: Level, t: Totals) => (level.rows !== undefined && t.rows >= level.rows) || (level.requests !== undefined && t.requests >= level.requests);

/* Market pages a person asked for lately (this server's memory; a restart forgets, which only delays an alert). */
const paging: Map<string, number[]> = ((globalThis as Record<string, unknown>).__portalPaging ??= new Map<string, number[]>()) as Map<string, number[]>;

/** After serving: count it, and tell our team about heavy or automated-looking use. Never throws, never refuses. */
export async function recordUse(db: Db, input: { who: string; role: UsageRole; portalId: string; kind: UsageKind; rows: number; page?: number; now: Date }): Promise<void> {
  try {
    const rows = Math.max(0, Math.floor(input.rows));
    const add: Res = await db.rpc("os_portal_usage_add", { p_day: day(input.now), p_who: norm(input.who), p_portal: input.portalId, p_kind: input.kind, p_requests: 1, p_rows: rows });
    fail(add, "os_portal_usage_add");
    if (input.role === "staff") return;
    const t = (add.data ?? {}) as { person?: Totals; portal?: Totals };
    const levels = HEAVY_USE[input.kind];
    for (const [scope, level, now] of [["person", levels.person, t.person], ["portal", levels.portal, t.portal]] as const) {
      if (!now) continue;
      const before = { requests: now.requests - 1, rows: now.rows - rows };
      if (past(level, now) && !past(level, before)) await alert(db, { ...input, scope, what: "heavy", now: input.now });
    }
    if (input.kind === "market" && (input.page ?? 1) > 1) {
      const key = `${norm(input.who)}|${input.portalId}`;
      const recent = (paging.get(key) ?? []).filter((at) => input.now.getTime() - at < PAGING_WINDOW_MS);
      recent.push(input.now.getTime());
      paging.set(key, recent);
      if (recent.length >= PAGING_PAGES) {
        paging.set(key, []);
        await alert(db, { ...input, scope: "person", what: "automated", now: input.now });
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ tag: "[portal-usage] record failed", error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));
  }
}

const KIND_TEXT: Record<UsageKind, string> = { market: "agents viewed", report: "reports", chat: "chat messages", billing: "billing page opens", conversation: "conversations opened" };

async function alert(db: Db, input: { who: string; portalId: string; kind: UsageKind; scope: "person" | "portal"; what: "heavy" | "automated"; now: Date }): Promise<void> {
  const p: Res = await db.from("clients").select("name").eq("id", input.portalId).maybeSingle();
  const name = ((p.data as { name?: string | null } | null)?.name ?? "").trim() || "a client portal";
  const whose = input.scope === "person" ? norm(input.who) : `${name} (everyone together)`;
  const level = HEAVY_USE[input.kind][input.scope];
  const amount = level.rows ?? level.requests ?? 0;
  const row =
    input.what === "automated"
      ? {
          kind: "portal_automated",
          severity: "critical",
          title: `Looks automated: ${norm(input.who)} on ${name}`,
          body: `${norm(input.who)} paged through ${name}'s Market ${PAGING_PAGES} times inside ${PAGING_WINDOW_MS / 60_000} minutes — faster than a person reads. Nothing was stopped; it may be someone copying the agent list.`,
          ref: `portal_automated:${day(input.now)}:${input.portalId}:${norm(input.who)}`,
        }
      : {
          kind: "portal_usage",
          severity: "warning",
          title: `Heavy use today: ${whose} — ${KIND_TEXT[input.kind]}`,
          body: `${whose} on ${name}'s portal has passed ${amount.toLocaleString("en-US")} ${KIND_TEXT[input.kind]} today. Nothing was stopped.`,
          ref: `portal_usage:${day(input.now)}:${input.portalId}:${input.scope === "person" ? norm(input.who) : "*"}:${input.kind}`,
        };
  const n: Res = await db.from("os_notifications").upsert(row, { onConflict: "ref", ignoreDuplicates: true });
  fail(n, "os_notifications");
}

/** Today's agents viewed per person on a portal, for the Portal logins list. */
export async function todayRows(db: Db, portalId: string, now: Date): Promise<Record<string, number>> {
  const r: Res = await db.from("os_portal_usage").select("who, rows").eq("day", day(now)).eq("portal_id", portalId).eq("kind", "market");
  fail(r, "os_portal_usage");
  const out: Record<string, number> = {};
  for (const x of (r.data ?? []) as Array<{ who: string; rows: number }>) out[norm(x.who)] = (out[norm(x.who)] ?? 0) + (x.rows ?? 0);
  return out;
}
