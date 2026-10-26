/*
 * My Agents and DNC → off the client's own campaigns (Eddy, 16 Oct: "Remove
 * all DNC and My agents from campaigns"; the user's go-ahead 26 Oct).
 *
 * The rules, kept pure so every one of them is tested without a database or a
 * campaign platform. The sweep (sweep.ts) does the reading and writing.
 *
 * ---------------------------------------------------------------------------
 * WHAT ALREADY HAPPENS, AND WHAT THIS ADDS
 *
 * A portal's My Agents and DNC adds already put the address on BOTH
 * platforms' workspace-wide blocklists (enforceBlocklist), so nobody on them
 * is emailed. That stays exactly as it is. This takes the person OFF the
 * client's own campaigns as well, so the campaign — and the new portal's
 * Prospects, which are the client's campaign leads — no longer lists them.
 *
 * ONE CLIENT'S CAMPAIGNS ONLY. A My Agents entry is the client's own agent: it
 * says nothing about another client's campaigns, so nothing here ever touches
 * a campaign the client does not own, and nothing here touches a blocklist.
 *
 * EMAIL ONLY. A DNC entry with a name and no address (most of them) cannot be
 * matched safely — two agents share a name more often than you would think —
 * and a company entry is a whole domain. Both are recorded as skipped.
 *
 * EmailBison only: every Instantly campaign is archived (26 Oct, 333 of 333),
 * and an archived campaign cannot send.
 */

export type ListSource = "my_agents" | "dnc";

export const SOURCE_LABEL: Record<ListSource, string> = { my_agents: "My Agents", dnc: "DNC" };

/** Exactly "1" — the same rule as every other live switch in the OS. */
export const LIVE_ENV = "OS_CAMPAIGN_CLEANUP_LIVE";
/** While set: live removals only from these EmailBison campaign ids; every other campaign is practised. */
export const LIVE_ONLY_ENV = "OS_CAMPAIGN_CLEANUP_LIVE_ONLY";
/** "0" stops the sweep outright, whatever the settings say. */
export const SWEEP_OFF_ENV = "OS_CAMPAIGN_CLEANUP";

export type Env = Readonly<Record<string, string | undefined>>;

export function liveAllowed(env: Env = process.env): boolean {
  return env[LIVE_ENV]?.trim() === "1";
}

export function sweepSwitchedOff(env: Env = process.env): boolean {
  return env[SWEEP_OFF_ENV]?.trim() === "0";
}

/**
 * The test fence: campaign ids a live removal may touch, or null for no fence.
 * Set but naming no valid id means nothing may be removed — a typo fails closed.
 */
export function liveOnlyCampaigns(env: Env = process.env): string[] | null {
  const raw = env[LIVE_ONLY_ENV];
  if (raw === undefined) return null;
  return raw.split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A real address, lower-cased — or null. */
export function normalEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return EMAIL.test(s) ? s : null;
}

export interface ListEntry {
  id: string;
  client_id: string;
  email: string | null;
  name: string | null;
  /** DNC only: 'agent' or 'company'. */
  kind?: string | null;
  created_at: string;
}

export type EntryTarget = { ok: true; email: string } | { ok: false; reason: SkipReason };

export type SkipReason = "company" | "no_email" | "demo" | "no_client";

export const SKIP_TEXT: Record<SkipReason, string> = {
  company: "A company entry — the domain is on the blocklists; campaigns are not searched by domain.",
  no_email: "No email address — a name alone is never matched to a campaign lead.",
  demo: "The Demo Portal — it never touches a campaign.",
  no_client: "This portal belongs to no single client in the OS.",
};

/** What a list entry would take off a campaign: one address, or the reason it takes nothing. */
export function entryTarget(entry: Pick<ListEntry, "email" | "kind">, source: ListSource): EntryTarget {
  if (source === "dnc" && (entry.kind ?? "agent") === "company") return { ok: false, reason: "company" };
  const email = normalEmail(entry.email);
  return email ? { ok: true, email } : { ok: false, reason: "no_email" };
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which OS client owns each portal row — the same rule as miRowsFor
 * (mi-status-mirror.ts), turned around: a client's linked row is theirs; any
 * other row is theirs when its name is the client's name or an alias. A row
 * whose name fits two clients belongs to neither — the sweep skips it rather
 * than guess.
 */
export function portalOwners(
  miRows: readonly { id: string; name: string; slug?: string | null }[],
  clients: readonly { id: string; name: string; aliases?: readonly string[] | null; miClientId: string | null }[],
): Map<string, string> {
  const linked = new Map<string, string>();
  for (const c of clients) if (c.miClientId) linked.set(c.miClientId, c.id);
  const byKey = new Map<string, Set<string>>();
  for (const c of clients) {
    for (const k of [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean)) {
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k)!.add(c.id);
    }
  }
  const out = new Map<string, string>();
  for (const r of miRows) {
    const owner = linked.get(r.id);
    if (owner) {
      out.set(r.id, owner);
      continue;
    }
    if (r.slug === "unknown") continue;
    const ids = byKey.get(norm(r.name));
    if (ids && ids.size === 1) out.set(r.id, [...ids][0]);
  }
  return out;
}

/** One EmailBison lead as the lead search returns it. */
export interface BisonLead {
  id: number;
  email: string;
  campaigns: { campaignId: number; status: string | null }[];
}

export interface ClientCampaign {
  id: string;
  name: string;
  status: string;
}

export interface PlannedRemoval {
  campaignId: string;
  campaignName: string;
  leadId: number;
  /** The lead's status in that campaign, as EmailBison reports it. */
  leadStatus: string | null;
}

/**
 * The client's campaigns this address is on. Only an EXACT address match
 * counts — EmailBison's search is a search, and a near miss is another person.
 */
export function planRemovals(email: string, leads: readonly BisonLead[], campaigns: readonly ClientCampaign[]): PlannedRemoval[] {
  const mine = new Map(campaigns.map((c) => [String(c.id), c]));
  const out: PlannedRemoval[] = [];
  const seen = new Set<string>();
  for (const lead of leads) {
    if (normalEmail(lead.email) !== email) continue;
    for (const lc of lead.campaigns) {
      const c = mine.get(String(lc.campaignId));
      const key = `${c?.id}:${lead.id}`;
      if (!c || seen.has(key)) continue;
      seen.add(key);
      out.push({ campaignId: String(c.id), campaignName: c.name, leadId: lead.id, leadStatus: lc.status ?? null });
    }
  }
  return out;
}

export interface GlobalSwitches {
  enabled: boolean;
  practiceMode: boolean;
}

export type CampaignMode = { live: true } | { live: false; reason: PracticeReason };

export type PracticeReason = "switched_off" | "practice_mode" | "server_locked" | "client_off" | "outside_fence";

export const PRACTICE_TEXT: Record<PracticeReason, string> = {
  switched_off: "The clean-up was switched off.",
  practice_mode: "Practice mode is on.",
  server_locked: `The server's lock is closed (${LIVE_ENV}).`,
  client_off: "This client's own switch is off.",
  outside_fence: `Outside the test fence (${LIVE_ONLY_ENV}).`,
};

/**
 * Whether one campaign's removal is real. EVERY condition must hold; each
 * default is "no", so a missing setting can only ever mean practice.
 */
export function campaignMode(
  switches: GlobalSwitches,
  clientSwitchOn: boolean,
  campaignId: string,
  env: Env = process.env,
): CampaignMode {
  if (switches.practiceMode) return { live: false, reason: "practice_mode" };
  if (!liveAllowed(env)) return { live: false, reason: "server_locked" };
  if (!clientSwitchOn) return { live: false, reason: "client_off" };
  const fence = liveOnlyCampaigns(env);
  if (fence !== null && !fence.includes(String(campaignId))) return { live: false, reason: "outside_fence" };
  return { live: true };
}

export type RemovalStatus = "pending" | "skipped" | "not_in_campaigns" | "practice" | "removed" | "partly_removed" | "failed";

export interface CampaignOutcome extends PlannedRemoval {
  outcome: "would_remove" | "removed" | "already_off" | "failed";
  reason?: string;
  error?: string;
}

/** The entry's status from its campaigns' outcomes. */
export function overallStatus(outcomes: readonly CampaignOutcome[]): RemovalStatus {
  if (!outcomes.length) return "not_in_campaigns";
  const done = outcomes.filter((o) => o.outcome === "removed" || o.outcome === "already_off").length;
  const failed = outcomes.filter((o) => o.outcome === "failed").length;
  if (!done && !failed) return "practice";
  if (failed && !done) return "failed";
  if (done === outcomes.length) return "removed";
  return "partly_removed";
}

/**
 * A timestamp to the MICROSECOND, as a sortable number. Postgres keeps
 * microseconds and Date.parse drops them, so two rows a few microseconds
 * apart would otherwise compare equal and be ordered by id instead.
 */
export function tsMicros(s: string): bigint {
  const frac = /\.(\d+)/.exec(s)?.[1] ?? "";
  const whole = Date.parse(s.replace(/\.\d+/, ""));
  if (!Number.isFinite(whole)) return BigInt(0);
  return BigInt(whole) * BigInt(1000) + BigInt((frac + "000000").slice(0, 6));
}

/** (created_at, id) order across both lists — the order the sweep works in. */
export function compareEntries(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  const x = tsMicros(a.created_at);
  const y = tsMicros(b.created_at);
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Keyset position: entries after (created_at, id). Bulk imports share one
 * created_at, hence the id. With no id (the moment the switch went on),
 * everything AT that moment is still to come.
 */
export function afterCursor(e: { created_at: string; id: string }, cursor: { at: string; id: string | null }): boolean {
  const a = tsMicros(e.created_at);
  const b = tsMicros(cursor.at);
  if (a !== b) return a > b;
  return cursor.id === null ? true : e.id > cursor.id;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** One line for the log: what happened to this entry, in words. */
export function removalLine(r: { status: RemovalStatus; reason: string | null; campaigns: readonly CampaignOutcome[]; error?: string | null }): string {
  const names = (o: readonly CampaignOutcome[]) => o.map((c) => c.campaignName || `#${c.campaignId}`).join(", ");
  const by = (k: CampaignOutcome["outcome"]) => r.campaigns.filter((c) => c.outcome === k);
  const off = [...by("removed"), ...by("already_off")];
  const would = by("would_remove");
  const failed = by("failed");
  switch (r.status) {
    case "pending":
      return "Being looked up…";
    case "skipped":
      return `Skipped — ${r.reason ?? "nothing to look up"}`;
    case "not_in_campaigns":
      return r.reason ?? "Not on any of this client's campaigns.";
    case "practice":
      return `Practice — would come off ${plural(would.length, "campaign")}: ${names(would)}. ${would[0]?.reason ?? ""}`.trim();
    case "removed":
      return `Removed from ${plural(off.length, "campaign")}: ${names(off)}.`;
    case "partly_removed":
      return [
        `Removed from ${names(off)}.`,
        would.length ? `Not from ${names(would)} — ${would[0].reason ?? "practice"}` : "",
        failed.length ? `Failed on ${names(failed)}: ${failed[0].error ?? "error"}` : "",
      ].filter(Boolean).join(" ");
    case "failed":
      return `Failed on ${names(failed)}: ${failed[0]?.error ?? r.error ?? "error"}`;
  }
}

/*
 * THE PROSPECTS CAMPAIGN, PRE-SELECTED (27 Oct, the user: "campaign should be
 * pre selected and we should have an option to change this via dropdown").
 * Until a person picks one, the client's Prospects go to its newest campaign
 * that is sending; else the newest about to send, paused, then draft. Never a
 * finished one. Newest = the highest EmailBison id (they only grow).
 */
const SUGGEST_RANK: Record<string, number> = { active: 0, launching: 1, queued: 1, paused: 2, draft: 3 };

export function suggestProspectsCampaign<C extends { id: string; status: string }>(campaigns: readonly C[]): C | null {
  let best: C | null = null;
  for (const c of campaigns) {
    const rank = SUGGEST_RANK[(c.status ?? "").toLowerCase()];
    if (rank === undefined || !/^\d+$/.test(c.id)) continue;
    if (!best) { best = c; continue; }
    const bestRank = SUGGEST_RANK[best.status.toLowerCase()];
    if (rank < bestRank || (rank === bestRank && Number(c.id) > Number(best.id))) best = c;
  }
  return best;
}

/** The order the dropdown lists them in: sending first, finished last; newest first within each. */
export function campaignChoiceOrder<C extends { id: string; status: string }>(campaigns: readonly C[]): C[] {
  const rank = (c: C) => SUGGEST_RANK[(c.status ?? "").toLowerCase()] ?? 9;
  return [...campaigns].sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id));
}

/** A campaign status, as a person reads it. */
export function campaignStatusWord(status: string): string {
  const s = (status ?? "").toLowerCase();
  return ({ active: "Sending", launching: "Starting", queued: "Queued", paused: "Paused", draft: "Draft", completed: "Finished", archived: "Archived" } as Record<string, string>)[s] ?? (s ? s[0].toUpperCase() + s.slice(1) : "Unknown");
}
