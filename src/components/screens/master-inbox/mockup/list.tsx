"use client";

import { useCallback, useMemo, useState } from "react";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels";
import type { ListRow } from "@/lib/tools/master-inbox/inbox/lists";
import { InboxLink, useInboxNav } from "@/components/master-inbox/inbox-nav";

import type { ThreadRow } from "@/lib/tools/master-inbox/inbox/threads";
import { shortStamp } from "@/lib/workspace/dates";
import { MockupSelectionBar } from "./selection-bar";
import { labelClass } from "./tabs";

/*
 * The conversation list, drawn the way the design draws it.
 *
 * ---------------------------------------------------------------------------
 * THE ROW IS ONE FLEX LINE OF FIXED CELLS
 *
 *   udot · cbx · tile · sndr · chips · subj · prev · tm
 *
 * `sndr` is fixed, `subj` caps at a share of the width, `prev` takes what is
 * left and ellipsises, `tm` is fixed at the end. Every cell is a single line,
 * which is precisely why nothing can push into anything else.
 *
 * The tool's own list renders one long preview line instead, which is why it
 * ran off the side of the window: there is no column structure to hold it.
 *
 * ---------------------------------------------------------------------------
 * DATA AND DESTINATIONS ARE THE TOOL'S
 *
 * `ThreadRow` is the tool's type, straight from its `loadThreads` — every field
 * below already exists on it, so nothing is adapted or re-derived. Each row
 * links to `/inbox/<view>/<id>`, the tool's own conversation route, so opening
 * a thread lands in the tool's ThreadView with its composer, prospect panel and
 * every action intact.
 */

export function MockupThreadList({
  threads, view, total, page, pageSize,
  now, labels, lists,
}: {
  threads: ThreadRow[];
  view: string;
  total: number;
  page: number;
  pageSize: number;
  /*
   * The server's clock, passed in rather than read here.
   *
   * `shortStamp` needs a "now" to decide between a time and a date, and reading
   * `Date.now()` during render gives the server one value and the client
   * another — a text mismatch that makes React throw the list away and rebuild
   * it. Seeded from the server, both agree.
   */
  now: number;
  /** Threaded through to the selection bar — see MockupSelectionBar. */
  labels?: LabelRow[];
  lists?: ListRow[];
}) {
  // Pager and rows navigate through the screen's transition so the
  // skeleton shows while the server responds — see inbox-nav.tsx.
  const { navigate } = useInboxNav();
  const [selected, setSelected] = useState<string[]>([]);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  const toggle = useCallback((id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }, []);

  const allIds = useMemo(() => threads.map((t) => t.id), [threads]);

  const goPage = useCallback((delta: number) => {
    const next = Math.min(Math.max(1, page + delta), lastPage);
    if (next === page) return;
    const url = new URL(window.location.href);
    url.searchParams.set("page", String(next));
    navigate(url.pathname + url.search);
  }, [page, lastPage, navigate]);

  return (
    <>
      <MockupSelectionBar
        selected={selected}
        total={total}
        page={page}
        lastPage={lastPage}
        pageSize={pageSize}
        onClear={() => setSelected([])}
        onSelectAll={() => setSelected(allIds)}
        onDone={() => setSelected([])}
        onPage={goPage}
        labels={labels}
        lists={lists}
        view={view}
      />

      <div className="mi-list" role="list">
        {threads.map((t) => {
          const isSelected = selected.includes(t.id);
          return (
            <InboxLink
              key={t.id}
              href={`/inbox/${view}/${t.id}`}
              className={`mi-row${t.seen ? " read" : ""}`}
              role="listitem"
            >
              {/* `off` keeps the row's spacing when there is nothing to show. */}
              <span className={`udot${t.seen ? " off" : ""}`} />

              {/* preventDefault as well as stopPropagation: the row is a link,
                  so ticking a checkbox inside it would otherwise navigate. */}
              <span
                className="cbx"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${t.subject ?? "conversation"}`}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(t.id); }}
                style={isSelected ? { background: "var(--blue)", borderColor: "var(--blue)" } : undefined}
              />

              <span className="tile">
                <svg viewBox="0 0 24 24">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="m22 7-10 6L2 7" />
                </svg>
              </span>

              <span className="sndr">{t.lead_full_name ?? t.lead_email ?? "Unknown sender"}</span>

              {/*
                The same metadata the tool's row carries, in the design's chip
                classes. The tile above is the tool's ChannelIcon (a mail glyph
                whatever the provider); `c-bison` / `c-inst` is its SourceBadge;
                then the client chip, the campaign chip and the labels.
              */}
              <span className="chips">
                {t.source_provider === "emailbison" ? <span className="c c-bison">EmailBison</span> : null}
                {t.source_provider === "instantly" ? <span className="c c-inst">Instantly</span> : null}
                {t.client_name ? <span className="c c-client">{t.client_name}</span> : null}
                {t.campaign_name ? <span className="c c-camp">{t.campaign_name}</span> : null}
                {/*
                  Two labels, as the tool's thread-list shows (`slice(0, 2)`).
                  An earlier pass cut this to one to protect the preview's
                  width; mi-inbox.css now gives each label chip its own floor
                  and ellipsis, so the second one fits without pushing the
                  preview out — and a thread that is both "Interested" and
                  "Introduction" reads as both from the list.
                */}
                {t.labels?.slice(0, 2).map((l) => (
                  <span key={l.name} className={labelClass(l.color)}>{l.name}</span>
                ))}
              </span>

              <span className="subj">{t.subject ?? "(no subject)"}</span>
              <span className="prev">{t.last_message_preview ?? ""}</span>
              <span className="tm tnum">{shortStamp(t.last_message_at, now)}</span>
            </InboxLink>
          );
        })}
      </div>
    </>
  );
}
