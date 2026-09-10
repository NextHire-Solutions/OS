import "server-only";

import { getOnboardingDb } from "./db";
import { swapForMove, type Stage } from "./stage-types";

export type { Stage } from "./stage-types";

/**
 * Pipeline stages — the team's own board.
 *
 * Ported from the orchestrator's `lib/stages.ts` and `app/stage-actions.ts`.
 * These are plain rows: add, rename, delete, reorder freely. NOTHING in the
 * automation reads a stage to decide whether to do work, and nothing but a human
 * write moves a client between them. The internal `orch_clients.status` column is
 * untouched and stays the automation's bookkeeping.
 *
 * The server actions became these functions unchanged apart from their error
 * shape: the tool returned `{ ok, error }` and called `revalidatePath`, which is
 * a Next server-action idea. Here the API route reports the failure and the
 * screen refetches, so the same result travels as JSON.
 */

export interface StagesBoard {
  stages: Stage[];
  /** How many clients stand on each stage, keyed by stage id. */
  counts: Record<string, number>;
  /** Clients whose `stage_id` is null — invisible on a stage board. */
  unplaced: number;
  error: string | null;
}

export async function getStages(): Promise<Stage[]> {
  const { data, error } = await getOnboardingDb()
    .from("orch_stages")
    .select("id, name, sort, color")
    .order("sort")
    .order("name");
  if (error) return [];
  return (data ?? []) as Stage[];
}

/** The stage list plus the client count standing on each — what the screen shows. */
export async function getStagesBoard(): Promise<StagesBoard> {
  try {
    const db = getOnboardingDb();
    const [stagesRes, placedRes] = await Promise.all([
      db.from("orch_stages").select("id, name, sort, color").order("sort").order("name"),
      db.from("orch_clients").select("stage_id"),
    ]);
    if (stagesRes.error) throw new Error(stagesRes.error.message);
    if (placedRes.error) throw new Error(placedRes.error.message);

    const stages = (stagesRes.data ?? []) as Stage[];
    const counts: Record<string, number> = {};
    let unplaced = 0;
    for (const row of (placedRes.data ?? []) as { stage_id: string | null }[]) {
      if (row.stage_id) counts[row.stage_id] = (counts[row.stage_id] ?? 0) + 1;
      else unplaced += 1;
    }
    return { stages, counts, unplaced, error: null };
  } catch (error) {
    // A failure costs this screen, never the workspace.
    return {
      stages: [],
      counts: {},
      unplaced: 0,
      error: error instanceof Error ? error.message : "Onboarding is unreachable",
    };
  }
}

export async function createStage(name: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "name required" };
  const stages = await getStages();
  const sort = (stages[stages.length - 1]?.sort ?? 0) + 10;
  const { data, error } = await getOnboardingDb()
    .from("orch_stages")
    .insert({ name: clean, sort, color: "neutral" })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data?.id as string };
}

export async function updateStage(
  id: string,
  patch: { name?: string; color?: string },
): Promise<{ ok: boolean; error?: string }> {
  const clean: Record<string, string> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) return { ok: false, error: "name cannot be empty" };
    clean.name = patch.name.trim();
  }
  if (patch.color !== undefined) clean.color = patch.color;
  if (!Object.keys(clean).length) return { ok: true };
  const { error } = await getOnboardingDb().from("orch_stages").update(clean).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Deleting a stage never touches the clients standing on it — the FK is
 * ON DELETE SET NULL, so they fall back to "unplaced" and show on the first
 * stage until someone moves them.
 */
export async function deleteStage(id: string): Promise<{ ok: boolean; error?: string; moved?: number }> {
  const stages = await getStages();
  if (stages.length <= 1) return { ok: false, error: "keep at least one stage" };
  const db = getOnboardingDb();
  const { count } = await db
    .from("orch_clients")
    .select("id", { count: "exact", head: true })
    .eq("stage_id", id);
  const { error } = await db.from("orch_stages").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, moved: count ?? 0 };
}

/** Reorder by swapping sort values with the neighbour in that direction. */
export async function moveStage(id: string, dir: "up" | "down"): Promise<{ ok: boolean; error?: string }> {
  const stages = await getStages();
  const swap = swapForMove(stages, id, dir);
  // Already at the end: the tool returns success and changes nothing, because
  // pressing ↑ on the top row is not an error, it is a no-op.
  if (!swap) return { ok: true };
  const db = getOnboardingDb();
  const [a, b] = await Promise.all([
    db.from("orch_stages").update({ sort: swap.a.sort }).eq("id", swap.a.id),
    db.from("orch_stages").update({ sort: swap.b.sort }).eq("id", swap.b.id),
  ]);
  const error = a.error ?? b.error;
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** The manual move. A label change only — it never triggers or skips any real work. */
export async function setClientStage(
  clientId: string,
  stageId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await getOnboardingDb()
    .from("orch_clients")
    .update({ stage_id: stageId || null, updated_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
