import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";

/*
 * What is left of the design's view tabs.
 *
 * `MockupTabs` — the row of pill links — used to live here. It was replaced by
 * the tool's own `TabBar` (src/components/master-inbox/tab-bar.tsx) because the
 * pills could only navigate: creating a view, renaming or deleting one, and
 * dragging tabs into a new order are all in the tool's component, and the
 * mockup's could not reach any of them. See full-inbox.tsx.
 *
 * `labelClass` stays, because the conversation list still draws its label
 * chips with the design's `.lc-*` classes.
 */

/** Label chips reuse the design's own colour classes rather than inline styles. */
export function labelClass(color: string | null | undefined): string {
  const c = (color ?? "").toLowerCase();
  if (c.includes("green")) return "lc lc-green";
  if (c.includes("red")) return "lc lc-red";
  if (c.includes("amber") || c.includes("yellow")) return "lc lc-amber";
  if (c.includes("pink") || c.includes("purple")) return "lc lc-pink";
  if (c.includes("stone")) return "lc lc-stone";
  return "lc lc-zinc";
}

export type { LabelRow };
