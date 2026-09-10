"use client";

import Link from "next/link";

import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import type { ViewCount } from "@/lib/tools/master-inbox/inbox/views";

/*
 * The design's view tabs — `.mi-tabs` / `.mi-tab` / `.cpill` / `.cpct`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE THE TOOL'S TabBar
 *
 * The tool's tab bar is a 471-line component with drag-to-reorder, a create
 * dialog and per-view menus, styled with Tailwind utilities. It works, and it
 * looks like the tool.
 *
 * The workspace is meant to look like the approved mockup, and the mockup draws
 * these tabs differently: pill-shaped, raised when active, with a blue count
 * pill and a muted percentage. That is not a colour difference — it is
 * different markup, and no amount of token remapping produces it.
 *
 * So the CHROME is the design's and the DATA is the tool's: the same
 * `loadViews` and `loadViewCounts` feed it, and every tab links to the same
 * `/inbox/<slug>` the tool uses. Nothing about which views exist, what they
 * count, or where they go is re-decided here.
 *
 * The heavy interior — the composer, the prospect panel, the filter builder —
 * stays the tool's, because the mockup does not draw those at all.
 */

export interface ViewTab {
  id: string;
  slug: string;
  name: string;
}

export function MockupTabs({
  views,
  activeSlug,
  counts,
}: {
  views: ViewTab[];
  activeSlug: string;
  /*
   * The tool's own numbers, not ours.
   *
   * `loadViewCounts` already returns exactly what the design draws: `unseen`
   * for the blue "N new" pill and `pct` for the muted percentage beside a
   * label view. Recomputing either here would be a second definition of the
   * same number, free to drift from what the tool reports.
   */
  counts: Record<string, ViewCount>;
}) {
  return (
    <div className="mi-tabs" role="tablist" aria-label="Inbox views">
      {views.map((v) => {
        const c = counts[v.slug];
        const active = v.slug === activeSlug;
        return (
          <Link
            key={v.id}
            href={`/inbox/${v.slug}`}
            className={`mi-tab${active ? " on" : ""}`}
            role="tab"
            aria-selected={active}
          >
            {v.name}
            {/* The pill only appears when there is something unread — an
                always-present "0" is noise on fifteen tabs. */}
            {c?.unseen ? <span className="cpill">{c.unseen.toLocaleString("en-US")} new</span> : null}
            {/* `pct` is null for views that are not a single-label filter
                (All Email), where a percentage would mean nothing. */}
            {c?.pct != null ? <span className="cpct">{c.pct}%</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

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
