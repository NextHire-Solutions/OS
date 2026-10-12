"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
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
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THE TOOL'S LIST DOES THAT THIS ONE HAD LOST (12 Oct)
 *
 *   · IT REMEMBERS WHERE YOU WERE. Opening a conversation replaces this screen,
 *     so coming back mounted a fresh list at the top — forty rows down, every
 *     time. `useScrollMemory` is the tool's hook of the same name
 *     (components/inbox/thread-list.tsx), pointed at the pane that scrolls
 *     here.
 *
 *   · A ROW YOU OPENED GREYS STRAIGHT AWAY. The tool keeps an `optimisticSeen`
 *     set so the blue dot goes on the click rather than after the round trip;
 *     `opened` is that set.
 *
 *   · THE "Unknown" CLIENT IS GREY, NOT AMBER. It is the bucket for replies
 *     nobody has been matched to, and in the client colour it read as a client
 *     called Unknown (the tool's ClientChip, `slug === "unknown"`).
 */

/** The nearest ancestor that scrolls — the shell's `.scroll` pane today. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/*
 * Scroll position, kept per list address for the life of the tab.
 *
 * Keyed by the whole address — view, client list, filter, page, search — so
 * page 2 does not inherit page 1's offset, which is what a per-view key does.
 *
 * Two details that are not obvious from the tool's version:
 *
 *   `behavior: "instant"`. The shell's pane is `scroll-behavior: smooth`, so a
 *   bare `scrollTop = n` glides there from the top over half a second.
 *
 *   The `offsetParent` check. While a navigation is pending the screen is
 *   hidden behind a skeleton (inbox-nav.tsx) but stays mounted; the pane
 *   shrinks, the browser clamps its scrollTop to 0 and fires `scroll`. Saving
 *   that would overwrite the position with 0 at exactly the moment it matters.
 */
function useScrollMemory(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const remember = useRef<() => void>(() => {});

  useEffect(() => {
    const list = ref.current;
    const scroller = scrollerOf(list);
    if (!list || !scroller) return;
    const storageKey = `mi-list-scroll:${key}`;

    let saved = 0;
    try {
      saved = Number(window.sessionStorage.getItem(storageKey)) || 0;
    } catch {
      // sessionStorage can throw in private-mode Safari; start at the top.
    }

    /*
     * Applied now and again on the next two frames: the router may scroll the
     * new screen into view after this effect has run, and whichever of the two
     * goes last would otherwise win.
     */
    let frames = 0;
    let raf = 0;
    const restore = () => {
      if (saved <= 0) return;
      if (Math.abs(scroller.scrollTop - saved) > 1) scroller.scrollTo({ top: saved, behavior: "instant" });
      if (++frames < 3) raf = window.requestAnimationFrame(restore);
    };
    restore();

    const save = () => {
      if (list.offsetParent === null) return;
      try {
        window.sessionStorage.setItem(storageKey, String(Math.round(scroller.scrollTop)));
      } catch {
        // ignore
      }
    };
    remember.current = save;
    scroller.addEventListener("scroll", save, { passive: true });
    return () => {
      window.cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", save);
      remember.current = () => {};
    };
  }, [key]);

  return { ref, remember };
}

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
  /*
   * The thread page's Back, Prev and Next rebuild the list you came from out
   * of ?list, ?f, ?page and ?q (thread-detail.tsx buildSuffix). This link
   * dropped all four, so opening a thread from a client list and pressing
   * Back landed on All Email.
   */
  const navParams = useSearchParams();
  const carry = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ["f", "list", "page", "q"]) {
      const v = navParams?.get(k);
      if (v) p.set(k, v);
    }
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [navParams]);
  // Pager and rows navigate through the screen's transition so the
  // skeleton shows while the server responds — see inbox-nav.tsx.
  const { navigate } = useInboxNav();
  const [selected, setSelected] = useState<string[]>([]);
  // Conversations opened from this list since it was drawn — see the note at
  // the top. Cleared with the selection so a bulk "mark as unseen" is not
  // contradicted by a row this set still remembers opening.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const { ref: listRef, remember } = useScrollMemory(`/inbox/${view}${carry}`);

  const toggle = useCallback((id: string) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }, []);

  const clear = useCallback(() => {
    setSelected([]);
    setOpened(new Set());
  }, []);

  const markOpened = useCallback((id: string) => {
    setOpened((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
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
        onClear={clear}
        onSelectAll={() => setSelected(allIds)}
        onDone={clear}
        onPage={goPage}
        labels={labels}
        lists={lists}
        view={view}
      />

      <div className="mi-list" role="list" ref={listRef}>
        {threads.map((t) => {
          const isSelected = selected.includes(t.id);
          const seen = t.seen || opened.has(t.id);
          return (
            <InboxLink
              key={t.id}
              href={`/inbox/${view}/${t.id}${carry}`}
              className={`mi-row${seen ? " read" : ""}${isSelected ? " sel" : ""}`}
              role="listitem"
              onClick={() => {
                remember.current();
                markOpened(t.id);
              }}
            >
              {/* `off` keeps the row's spacing when there is nothing to show. */}
              <span className={`udot${seen ? " off" : ""}`} />

              {/*
                preventDefault as well as stopPropagation: the row is a link,
                so ticking a checkbox inside it would otherwise navigate.

                The box is 18px but its target is the whole left end of the
                row (mi-inbox.css gives it a `::before` that reaches the row's
                edges): a near miss used to open the conversation, which also
                marks it read. The tick is drawn from `aria-checked`.
              */}
              <span
                className="cbx"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${t.subject ?? "conversation"}`}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(t.id); }}
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

                Each chip names itself on hover, as the tool's do — they
                ellipsise here, and "Properties & Estates Fl…" is otherwise the
                only thing the row says about which client it is.
              */}
              <span className="chips">
                {t.source_provider === "emailbison" ? <span className="c c-bison">EmailBison</span> : null}
                {t.source_provider === "instantly" ? <span className="c c-inst">Instantly</span> : null}
                {t.client_name ? (
                  <span
                    className={`c c-client${t.client_slug === "unknown" ? " c-unknown" : ""}`}
                    title={`Client: ${t.client_name}`}
                  >
                    {t.client_name}
                  </span>
                ) : null}
                {t.campaign_name ? (
                  <span className="c c-camp" title={`Campaign: ${t.campaign_name}`}>{t.campaign_name}</span>
                ) : null}
                {/*
                  Two labels, as the tool's thread-list shows (`slice(0, 2)`).
                  An earlier pass cut this to one to protect the preview's
                  width; mi-inbox.css now gives each label chip its own floor
                  and ellipsis, so the second one fits without pushing the
                  preview out — and a thread that is both "Interested" and
                  "Introduction" reads as both from the list.
                */}
                {t.labels?.slice(0, 2).map((l) => (
                  <span key={l.name} className={labelClass(l.color)} title={l.name}>{l.name}</span>
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
