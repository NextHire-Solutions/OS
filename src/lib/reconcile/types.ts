/*
 * Reconciliation — showing where the tools disagree, and why.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 *
 * The team files tickets saying "Client Health says 41 clients but Analytics
 * says 38" and "the intro count doesn't match the portal". Those are read as
 * bugs. Mostly they are not: each tool computes its number from a different
 * source, over a different window, using a different definition of the thing
 * being counted.
 *
 * So the fix is NOT to force one number. Forcing one number would mean picking
 * a winner and silently making the other three wrong somewhere else. The fix is
 * to put the numbers side by side WITH the definition each one is using, so the
 * difference stops being a mystery and becomes a fact you can act on — or
 * deliberately ignore.
 *
 * That is why `definition` below is a required field and not a comment. A
 * reading without its definition is exactly the thing that generated the
 * tickets in the first place.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * Not a migration, not a shared database, not a write path. Every reading is
 * fetched over the tool's normal HTTP API. This layer cannot change anything in
 * any tool; it can only read and compare.
 */

import type { ToolId } from "@/lib/bs-auth";

/** A thing the business counts, which more than one tool claims to know. */
export type ConceptId =
  | "clients"
  | "emails-sent"
  | "replies"
  | "introductions";

export interface Concept {
  id: ConceptId;
  /** What a person would call it. */
  label: string;
  /** Plain-language statement of what is being counted. */
  question: string;
  /**
   * How much difference is unremarkable, as a fraction.
   *
   * Not zero, and not a fudge factor. Two systems polling different upstreams
   * seconds apart will legitimately differ by a row or two; flagging that would
   * train people to ignore the screen, which is the failure mode this whole
   * feature exists to prevent.
   */
  tolerance: number;
  sources: SourceSpec[];
}

export interface SourceSpec {
  /** Which tool answers. */
  tool: ToolId;
  /** Distinguishes two readings from the same tool (e.g. two endpoints). */
  key: string;
  label: string;
  /**
   * EXACTLY what this source counts and over what window, in plain language.
   *
   * The single most valuable field here. Half the disputes dissolve the moment
   * both numbers are shown next to a sentence explaining that one counts
   * business hours in New York and the other counts calendar weeks.
   */
  definition: string;
  /** Which upstream system the number ultimately comes from. */
  origin: string;
  /** Set when reading it needs a token that may not be configured. */
  requiresEnv?: string;

  /*
   * The two fields below exist so divergence can be classified STRUCTURALLY
   * rather than by reading the prose in `definition`. Sniffing the sentence for
   * the word "week" would work until someone rephrased it, and then the screen
   * would start calling explained differences unexplained — the one failure
   * that would make people stop trusting it.
   */

  /** The period covered. Two sources with different windows will differ, correctly. */
  window: "all-time" | "30d" | "iso-week" | "current";

  /**
   * Which sending platforms feed this number.
   *
   * The most common real cause of disagreement in this stack: Analytics sees
   * EmailBison only, while Client Health sums Instantly and EmailBison. Two
   * correct numbers, different denominators.
   */
  platforms: string[];
}

/** One tool's answer, or the reason there isn't one. */
export interface Reading {
  tool: ToolId;
  key: string;
  label: string;
  definition: string;
  origin: string;
  value: number | null;
  /** Present when `value` is null. */
  unavailable?: string;
  /** The window this reading actually covers, when the source states it. */
  window?: string;
  fetchedAt: string;
}

/**
 * Why two readings differ. Ordered from "nothing to see" to "worth a look".
 *
 * `definition` and `window` are deliberately separate from `unexplained`: the
 * first two are expected disagreements a person should understand and move on
 * from, the third is the only one that might be a genuine fault.
 */
export type DivergenceKind =
  | "agree"
  | "window"
  | "definition"
  | "unexplained"
  | "insufficient";

export interface Comparison {
  concept: ConceptId;
  label: string;
  question: string;
  readings: Reading[];
  /** Highest and lowest available readings, and the gap between them. */
  spread: {
    min: number;
    max: number;
    /** Absolute difference. */
    delta: number;
    /** As a fraction of the larger value. */
    relative: number;
  } | null;
  divergence: DivergenceKind;
  /** One sentence a person can act on. */
  verdict: string;
}

export interface ReconcileReport {
  comparisons: Comparison[];
  generatedAt: string;
  /** Counts by divergence, for a headline. */
  summary: Record<DivergenceKind, number>;
}
