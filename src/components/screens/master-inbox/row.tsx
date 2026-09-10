"use client";

import type { ThreadRow } from "@/lib/tools/master-inbox/inbox-view";
import { shortStamp } from "@/lib/workspace/dates";

/*
 * One conversation row, exactly as the design draws it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The first version of this list was built with my own inline styles while
 * borrowing the design's class names, and it collapsed: rows overlapped, label
 * chips floated loose in the middle of the text. The design's row is ONE flex
 * line of fixed-width cells and it only works if the markup is that shape.
 *
 *   udot · cbx · tile · sndr · chips · subj · prev · tm
 *
 * `sndr` is a fixed 160px, `subj` caps at 26%, `prev` takes the rest and
 * ellipsises, `tm` is fixed at the end. Every one is a single line — which is
 * why nothing can push into anything else.
 *
 * The lesson, written here rather than in a commit nobody re-reads: when a
 * design ships a stylesheet, the markup is part of the design. Reading the CSS
 * and inventing the HTML is how you get a screen that uses all the right class
 * names and looks nothing like the picture.
 */

/** The tool's own sentiment colours, mapped to the design's label classes. */
function labelClass(color: string | null | undefined, sentiment?: string | null): string {
  const c = (color ?? "").toLowerCase();
  if (c.includes("green") || sentiment === "positive") return "lc lc-green";
  if (c.includes("red") || sentiment === "negative") return "lc lc-red";
  if (c.includes("amber") || c.includes("yellow")) return "lc lc-amber";
  if (c.includes("pink") || c.includes("purple")) return "lc lc-pink";
  return "lc lc-zinc";
}

export function InboxRow({
  t, open, selected, onOpen, onToggle, now,
}: {
  t: ThreadRow;
  open: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  now: number;
}) {
  return (
    <div
      className={`mi-row${t.seen ? " read" : ""}`}
      onClick={onOpen}
      role="listitem"
      style={open ? { background: "var(--inset)", cursor: "pointer" } : { cursor: "pointer" }}
    >
      {/* Unread marker. `off` keeps the row's spacing when there is nothing to show. */}
      <span className={`udot${t.seen ? " off" : ""}`} />

      {/* Selection. stopPropagation so ticking a row does not also open it. */}
      <span
        className="cbx"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${t.subject ?? "conversation"}`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        style={selected ? { background: "var(--blue)", borderColor: "var(--blue)" } : undefined}
      />

      <span className="tile">
        <svg viewBox="0 0 24 24">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-10 6L2 7" />
        </svg>
      </span>

      <span className="sndr">{t.lead_full_name ?? t.lead_email ?? "Unknown sender"}</span>

      <span className="chips">
        {t.source_provider === "emailbison" ? (
          <span className="c c-bison">EmailBison</span>
        ) : t.source_provider === "instantly" ? (
          <span className="c c-inst">Instantly</span>
        ) : null}
        {t.client_name ? <span className="c c-client">{t.client_name}</span> : null}
        {t.campaign_name ? <span className="c c-camp">{t.campaign_name}</span> : null}
        {t.labels?.slice(0, 2).map((l) => (
          <span key={l.name} className={labelClass(l.color)}>{l.name}</span>
        ))}
        {t.needs_reply ? <span className="lc lc-amber">needs reply</span> : null}
      </span>

      <span className="subj">{t.subject ?? "(no subject)"}</span>
      <span className="prev">{t.last_message_preview ?? ""}</span>
      <span className="tm tnum">{shortStamp(t.last_message_at, now)}</span>
    </div>
  );
}

/*
 * The narrow rail card, used while a conversation is open.
 *
 * The design draws this differently from the full-width row rather than just
 * shrinking it, and the reason is visible the moment you try: sender, chips,
 * subject and preview on one 320px line leaves each of them a few characters
 * wide. Here they stack, and only the two most useful chips survive.
 */
export function RailCard({
  t, open, onOpen, now,
}: {
  t: ThreadRow;
  open: boolean;
  onOpen: () => void;
  now: number;
}) {
  return (
    <div
      onClick={onOpen}
      role="listitem"
      style={{
        padding: 12,
        borderBottom: "1px solid var(--line-soft)",
        background: open ? "var(--inset)" : t.seen ? "var(--surface)" : "var(--surface)",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span className={`udot${t.seen ? " off" : ""}`} />
        <span className="tile">
          <svg viewBox="0 0 24 24">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-10 6L2 7" />
          </svg>
        </span>
        <b style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.lead_full_name ?? t.lead_email ?? "Unknown sender"}
        </b>
        <span className="tm tnum" style={{ fontSize: 11 }}>{shortStamp(t.last_message_at, now)}</span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.subject ?? "(no subject)"}
      </div>

      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.last_message_preview ?? ""}
      </div>

      <div className="chips" style={{ marginTop: 6, flexWrap: "wrap" }}>
        {t.source_provider === "emailbison" ? <span className="c c-bison">EmailBison</span> : null}
        {t.source_provider === "instantly" ? <span className="c c-inst">Instantly</span> : null}
        {t.labels?.slice(0, 1).map((l) => (
          <span key={l.name} className={labelClass(l.color)}>{l.name}</span>
        ))}
      </div>
    </div>
  );
}
