/**
 * Stage shapes and constants — no server imports, so client components can use
 * them freely.
 *
 * The orchestrator's own `lib/stage-types.ts` mapped each colour to ITS
 * stylesheet's custom properties. The workspace has its own palette, so the
 * tints below name workspace tokens instead. The colour NAMES stored in
 * `orch_stages.color` are unchanged — they are the same five the tool writes,
 * so a stage recoloured here shows the same colour in the live tool.
 */

export type Stage = { id: string; name: string; sort: number; color: string | null };

/** Badge tints offered in the stage editor — exactly the tool's five. */
export const STAGE_COLORS = ["neutral", "blue", "green", "amber", "red"] as const;

export type StageColor = (typeof STAGE_COLORS)[number];

/**
 * A stage's colour in workspace tokens: a soft wash to sit behind the label and
 * an ink that stays readable on it.
 *
 * `--blue-bg` does not exist in workspace.css — the token is `--blue-pale`.
 * Naming it correctly here rather than relying on a CSS fallback keeps the one
 * definition of "blue" in one place.
 */
export const STAGE_TONE: Record<string, { bg: string; fg: string }> = {
  neutral: { bg: "var(--inset-2)", fg: "var(--ink-2)" },
  blue: { bg: "var(--blue-pale)", fg: "var(--blue-ink)" },
  green: { bg: "var(--green-bg)", fg: "var(--green)" },
  amber: { bg: "var(--yellow-bg)", fg: "var(--yellow)" },
  red: { bg: "var(--red-bg)", fg: "var(--red)" },
};

/** The tint for a stored colour, falling back to neutral for anything unknown. */
export function toneOf(color: string | null | undefined): { bg: string; fg: string } {
  return STAGE_TONE[color ?? "neutral"] ?? STAGE_TONE.neutral;
}

/** Clients with no stage yet (new arrivals, or their stage was deleted) sit on the first one. */
export function stageOf(stages: Stage[], stageId: string | null | undefined): Stage | null {
  if (stageId) return stages.find((s) => s.id === stageId) ?? stages[0] ?? null;
  return stages[0] ?? null;
}

/**
 * The sort values a swap would produce, as a pure function.
 *
 * The orchestrator does this inline inside its server action, where it cannot be
 * tested without a database. Pulling the arithmetic out means the reorder rule —
 * "swap sort values with the neighbour in that direction, and do nothing at
 * either end" — is checkable on its own.
 */
export function swapForMove(
  stages: Stage[],
  id: string,
  dir: "up" | "down",
): { a: { id: string; sort: number }; b: { id: string; sort: number } } | null {
  const i = stages.findIndex((s) => s.id === id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= stages.length) return null;
  return {
    a: { id: stages[i].id, sort: stages[j].sort },
    b: { id: stages[j].id, sort: stages[i].sort },
  };
}
