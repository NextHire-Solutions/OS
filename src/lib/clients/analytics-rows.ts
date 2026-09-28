/*
 * The Analytics client row, as the standalone Analytics app writes it — the
 * pure half (validation and the exact values written), so it is tested
 * without a database. The server half is analytics-direct.ts.
 *
 * Copied from Campaign-tool @ 68ed3cb, src/app/api/clients/route.ts (POST) and
 * src/app/api/clients/[id]/route.ts (PATCH): same limits, same trimming, same
 * slug, same defaults. Tested in analytics-rows.test.ts.
 */

export type MatchMode = "contains" | "prefix" | "exact";
export type LifecycleStatus = "onboarding" | "active" | "paused" | "churned";

const MODES: MatchMode[] = ["contains", "prefix", "exact"];
const STATUSES: LifecycleStatus[] = ["onboarding", "active", "paused", "churned"];

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const aliasesOk = (a: unknown): a is string[] =>
  Array.isArray(a) && a.length <= 20 && a.every((x) => typeof x === "string" && x.length >= 1);

export interface NewClient {
  name: string;
  aliases?: string[];
  matchMode?: MatchMode;
}

/** The row POST /api/clients inserts, or null when the tool would answer 400 "Invalid client". */
export function insertRow(input: NewClient, teamId: number): Record<string, unknown> | null {
  if (typeof input?.name !== "string" || input.name.length < 1 || input.name.length > 200) return null;
  if (input.aliases !== undefined && !aliasesOk(input.aliases)) return null;
  if (input.matchMode !== undefined && !MODES.includes(input.matchMode)) return null;
  return {
    team_id: teamId,
    name: input.name.trim(),
    slug: slugify(input.name),
    aliases: input.aliases ?? [],
    match_mode: input.matchMode ?? "contains",
  };
}

export interface ClientPatch {
  name?: string;
  aliases?: string[];
  matchMode?: MatchMode;
  active?: boolean;
  status?: LifecycleStatus;
}

/** The update PATCH /api/clients/:id applies, or null when it would answer 400 "Invalid update". */
export function updateRow(p: ClientPatch, now: Date = new Date()): Record<string, unknown> | null {
  if (p.name !== undefined && (typeof p.name !== "string" || p.name.length < 1 || p.name.length > 200)) return null;
  if (p.aliases !== undefined && !aliasesOk(p.aliases)) return null;
  if (p.matchMode !== undefined && !MODES.includes(p.matchMode)) return null;
  if (p.active !== undefined && typeof p.active !== "boolean") return null;
  if (p.status !== undefined && !STATUSES.includes(p.status)) return null;
  const patch: Record<string, unknown> = { updated_at: now.toISOString() };
  if (p.name !== undefined) patch.name = p.name.trim();
  if (p.aliases !== undefined) patch.aliases = p.aliases;
  if (p.matchMode !== undefined) patch.match_mode = p.matchMode;
  if (p.active !== undefined) patch.active = p.active;
  if (p.status !== undefined) patch.status = p.status;
  return patch;
}
