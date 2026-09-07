"use client";

/*
 * The top bar: sidebar toggle, breadcrumb, command palette.
 *
 * The toggle lives HERE rather than inside the rail, which is the design's
 * choice and a good one — a control that travels when you press it is a
 * control you have to hunt for the second time.
 */

export interface TopbarProps {
  /** e.g. ["Master Inbox", "All Email"] — last segment is the current page. */
  crumbs: string[];
  collapsed: boolean;
  onToggleRail: () => void;
  onOpenPalette: () => void;
}

export function Topbar({ crumbs, collapsed, onToggleRail, onOpenPalette }: TopbarProps) {
  const trail = crumbs.slice(0, -1);
  const current = crumbs[crumbs.length - 1] ?? "";

  return (
    <header className="topbar">
      <button
        className="rail-toggle"
        type="button"
        aria-expanded={!collapsed}
        aria-controls="rail"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-keyshortcuts="Meta+\\"
        onClick={onToggleRail}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2.75" y="4.25" width="18.5" height="15.5" rx="4" />
          <path d="M9.4 4.25v15.5" />
          <rect
            className="fillpane"
            x="4.15"
            y="5.65"
            width="3.9"
            height="12.7"
            rx="2"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      </button>

      <span className="tb-div" aria-hidden="true" />

      <span className="crumb">
        {trail.map((c) => (
          <span key={c}>{c}&nbsp;›&nbsp;</span>
        ))}
        <b>{current}</b>
      </span>

      <span className="spacer" />

      <button className="search-btn" onClick={onOpenPalette} aria-haspopup="dialog">
        <svg className="ico" style={{ opacity: 0.6 }} viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        Search or jump to… <kbd>⌘K</kbd>
      </button>
    </header>
  );
}
