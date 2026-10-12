"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Plus, Search } from "lucide-react";

import type { ListRow } from "@/lib/tools/master-inbox/inbox/lists-shared";
import {
  normalizeClientName,
  type ClientStatus,
} from "@/lib/tools/master-inbox/inbox/lists-shared";
import { CreateListDialog } from "@/components/master-inbox/create-list-dialog";
import { DeleteListDialog } from "@/components/master-inbox/delete-list-dialog";
import { InboxLink } from "@/components/master-inbox/inbox-nav";
import { useDismiss } from "@/components/master-inbox/use-dismiss";
import { closeClientsDrawer, useClientsPanel } from "./clients-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";

/*
 * The client lists rail.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 *
 * One entry per client, created automatically when that client is onboarded.
 * Choosing one filters the inbox to that client's conversations — the tool
 * passes it as `?list=<id>`, which `loadThreads` already understands, so
 * nothing about filtering is reimplemented here.
 *
 * The dot is the client's HEALTH: green active, amber paused, red churned.
 * When the status feed has no answer for a client, the row shows the list's
 * own emoji instead (`list.icon ?? "📁"`) — the tool's rule, in
 * `components/layout/sidebar.tsx` ListRow.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BACK
 *
 * The tool has had this since the beginning. When the inbox list was rebuilt
 * against the mockup, `loadLists` was dropped from the loaders and the rail
 * went with it — a feature lost in a change that was only meant to alter
 * appearance. That is the exact failure this project keeps guarding against,
 * and it happened anyway.
 *
 * ---------------------------------------------------------------------------
 * THE RAIL IS EDITABLE, AS THE TOOL'S SIDEBAR IS
 *
 * The first restored version drew the lists as plain links. The tool's
 * sidebar does more: "Create list item" at the foot of the list, and a
 * hover-revealed menu on every row with Edit (name and icon) and Delete. Those
 * are the tool's own dialogs — `CreateListDialog` in both its create and edit
 * modes, and `DeleteListDialog` — wired exactly as `components/layout/
 * sidebar.tsx` wires them: the parent owns the dialog state so two rows can
 * never open conflicting dialogs, and every change ends in `router.refresh()`
 * so the server-rendered rail picks up the new row.
 *
 * ---------------------------------------------------------------------------
 * THE REST OF THE TOOL'S SIDEBAR, RESTORED BY THE COMPLETENESS AUDIT
 *
 *   · THE "N new" PILL. `listCounts` is `loadListUnseenCounts` — list id to
 *     count of unseen open threads — loaded by the screen alongside
 *     `loadLists`, as the tool's app-shell loads it. Shown only when the
 *     count is above zero; capped at "99+".
 *
 *   · THE SEARCH BOX, above the scrolling lists so it never falls off-screen,
 *     filtering by name in place. Its odd attributes are the tool's
 *     Chrome-autofill guard — see the note on the input.
 *
 *   · THE DRAG-RESIZE HANDLE on the right edge, 200–480px, the width kept in
 *     localStorage under the tool's own key so a preference survives reloads.
 *     Same mechanics as the prospect panel's handle (prospect-panel.tsx),
 *     mirrored to the opposite edge.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS COPIED DELIBERATELY FROM THE TOOL
 *
 * STATUS IS FETCHED AFTER MOUNT AND FAILS OPEN. `/api/clients/status` is an
 * external feed. If it is slow or down, the rail renders with no dots and the
 * inbox is unaffected. It must never be able to block or break the list of
 * conversations, which is the thing people actually came for.
 *
 * THE JOIN IS BY NORMALISED NAME, NOT ID. The status feed and the inbox track
 * the same clients under different ids and slightly different display names
 * ("C21 Results - Elite Team" versus "C21 Results Elite Team"), so name is the
 * only key available. `normalizeClientName` is the tool's own helper — shared,
 * not re-written, so the two can never drift apart.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THE TOOL'S SIDEBAR HAS THAT THIS ONE WAS MISSING (12 Oct)
 *
 *   · THE COUNTS — `● 28 ● 9 ● 17`, active / paused / churned, under the
 *     search box. The status route has always returned `counts` beside
 *     `byName`; this component kept one and dropped the other. They are
 *     CLIENTS, from the master record — not lists, and not the dots below
 *     counted up (a client with two portals has two lists and is one client).
 *
 *   · IT STAYS BESIDE AN OPEN CONVERSATION. The conversation screen never
 *     rendered it. `collapsible` is that screen's mode: the panel can be
 *     hidden with the "Clients" button in the filter bar, and on a narrow
 *     stage it opens as a drawer instead of taking a column. Which of the two
 *     is decided in mi-inbox.css; the state is in clients-panel.ts. On the
 *     list screen nothing about the panel changes.
 */

const STATUS_LABEL: Record<ClientStatus, string> = {
  active: "Active",
  paused: "Paused",
  churned: "Churned",
};

// The rail is user-resizable via the drag handle on its right edge. Width is
// persisted in localStorage so the preference survives reloads. The
// server-rendered default matches DEFAULT_WIDTH so the first paint is
// stable; useEffect then restores any saved value. Key, default and clamp
// are the tool's (components/layout/sidebar.tsx).
/*
 * What the panel last knew, kept for the life of the tab.
 *
 * ---------------------------------------------------------------------------
 * WHY
 *
 * In the tool this sidebar lives in a layout and is mounted once. Here it is
 * part of the screen, and the workspace's one catch-all route rebuilds the
 * screen on every navigation — every tab, every page, every conversation. Each
 * rebuild started the panel from nothing: folder emoji where the status dots
 * go, no counts, no "N new" pills, the client list scrolled back to the top,
 * and then all of it popping back a few hundred milliseconds later when the
 * status feed answered. Stepping through conversations with the panel beside
 * them made that a blink on every step.
 *
 * So a fresh panel starts from the last panel's answers and refreshes them
 * behind the scenes, which is what a mounted-once sidebar looks like.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SAFE TO KEEP AT MODULE LEVEL
 *
 * It is written only from effects and fetch callbacks, which never run during
 * server rendering — so on the server it stays empty for every request and
 * nothing one person saw can reach another. In the browser it is empty on a
 * full page load, which is the only time React hydrates, so the first client
 * render always matches the server's. It holds counts and statuses, the same
 * things the panel is already showing.
 */
const remembered: {
  status: Record<string, ClientStatus> | null;
  counts: Record<ClientStatus, number> | null;
  unseen: Record<string, number> | null;
  scrollTop: number;
} = { status: null, counts: null, unseen: null, scrollTop: 0 };

const SIDEBAR_WIDTH_KEY = "sales-inbox-sidebar-width";
const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export function ClientLists({
  lists,
  activeListId,
  view,
  listCounts = {},
  listCountsLater,
  collapsible = false,
  initialCollapsed = false,
}: {
  lists: ListRow[];
  activeListId: string | null;
  view: string;
  /** list id → count of unseen open threads; drives the "N new" pill. */
  listCounts?: Record<string, number>;
  /*
   * The same counts, as a promise the server has not finished yet. The
   * conversation screen passes this instead of `listCounts` so that opening a
   * conversation does not wait for a pill in a side panel (thread-detail.tsx
   * has the numbers). Read with `.then`, not `use()`: nothing here should
   * suspend, and the panel must not be thrown away and rebuilt when it lands.
   */
  listCountsLater?: Promise<Record<string, number>>;
  /** Beside an open conversation: can be hidden, and is a drawer when narrow. */
  collapsible?: boolean;
  /** What the server read from the cookie — see clients-panel-cookie.ts. */
  initialCollapsed?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Record<string, ClientStatus>>(() => remembered.status ?? {});
  const [counts, setCounts] = useState<Record<ClientStatus, number> | null>(() => remembered.counts);
  /*
   * Has the status feed answered (in this tab, ever)? Until it has, a row
   * holds a neutral dot and the counts strip holds its space — the emoji
   * fallback is for "the feed has no status for this client", and showing it
   * for "the feed has not answered yet" made every row flash a folder on the
   * way to its dot.
   */
  const [statusKnown, setStatusKnown] = useState(() => remembered.status !== null);
  // Starts from the last counts this tab saw, and holds them until the new
  // promise resolves: a pill that blinks out and back says nothing true.
  const [lateCounts, setLateCounts] = useState<Record<string, number> | null>(
    () => (listCountsLater ? remembered.unseen : null),
  );
  useEffect(() => {
    if (!listCountsLater) return;
    let live = true;
    listCountsLater.then(
      (value) => {
        remembered.unseen = value;
        if (live) setLateCounts(value);
      },
      () => { /* no pills; the panel is unaffected */ },
    );
    return () => { live = false; };
  }, [listCountsLater]);
  // The list screen's counts came with the page; remember them so a
  // conversation opened from it starts with the same pills.
  useEffect(() => {
    if (!listCountsLater) remembered.unseen = listCounts;
  }, [listCountsLater, listCounts]);
  const unseenByList = lateCounts ?? listCounts;
  const [createOpen, setCreateOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [editingList, setEditingList] = useState<ListRow | null>(null);
  const [deletingList, setDeletingList] = useState<ListRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools/master-inbox/clients/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!json?.byName) {
          // Answered, with nothing: stop holding space for it.
          if (!cancelled) setStatusKnown(true);
          return;
        }
        remembered.status = json.byName as Record<string, ClientStatus>;
        const fresh = json.counts as Partial<Record<ClientStatus, unknown>> | null | undefined;
        remembered.counts =
          fresh && [fresh.active, fresh.paused, fresh.churned].every((n) => typeof n === "number")
            ? (fresh as Record<ClientStatus, number>)
            : null;
        if (cancelled) return;
        setStatusKnown(true);
        /*
         * `byName` is already keyed by the normalised client name and already
         * narrowed to the three statuses — the route does that work once,
         * server-side, so every browser does not repeat it. An earlier version
         * of this component guessed at a `clients` array and silently found
         * nothing: the rail rendered with no dots and looked merely undecided
         * rather than broken.
         */
        setStatus(remembered.status);
        // Null when the feed could not be read; the strip is then not drawn,
        // rather than drawn as three zeroes that look like an answer.
        setCounts(remembered.counts);
      })
      .catch(() => {
        /* Fail open — no dots, inbox unaffected. See the note above. */
        if (!cancelled) setStatusKnown(true);
      });
    return () => { cancelled = true; };
  }, []);

  // ---- beside a conversation: hidden, column or drawer ----
  const panel = useClientsPanel(initialCollapsed);
  const asideRef = useRef<HTMLElement>(null);
  useDismiss(
    collapsible && panel.drawer,
    closeClientsDrawer,
    (target) =>
      Boolean(asideRef.current?.contains(target)) ||
      (target instanceof Element && target.closest(".mi-clients-toggle") !== null),
  );
  // The drawer is momentary. Leaving the screen with it open must not mean
  // the next conversation arrives with it open.
  useEffect(() => {
    if (!collapsible) return;
    return () => closeClientsDrawer();
  }, [collapsible]);

  // ---- resize ----
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Mirror the latest width into a ref so the pointer-up handler can read it
  // without re-binding the effect on every width change.
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (!saved) return;
      const n = Number(saved);
      if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) setWidth(n);
    } catch {
      // localStorage can throw in private-mode Safari; ignore.
    }
  }, []);

  // Global pointer handlers active only while dragging. Listening on window
  // (not the handle) so the drag keeps tracking even if the cursor moves
  // outside the thin strip.
  useEffect(() => {
    if (!resizing) return;
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      // Handle is on the RIGHT edge — dragging right widens the rail.
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, d.startWidth + (e.clientX - d.startX)),
      );
      setWidth(next);
    }
    function onUp() {
      setResizing(false);
      dragRef.current = null;
      try {
        // Persist on release, not every move, so localStorage doesn't get
        // hammered during the drag.
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current));
      } catch {
        // ignore
      }
    }
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing]);

  // The client list keeps its place across the rebuilds described at
  // `remembered` — a layout effect, so it is in place before the first paint.
  const listScrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (listScrollRef.current && remembered.scrollTop > 0) listScrollRef.current.scrollTop = remembered.scrollTop;
  }, []);

  function onHandlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { startX: e.clientX, startWidth: width };
    setResizing(true);
    e.preventDefault();
  }

  const rows = useMemo(
    () => lists.map((l) => ({ ...l, status: status[normalizeClientName(l.name)] ?? null })),
    [lists, status],
  );

  // Search just filters the server-sorted list in place, as the tool does.
  const needle = listSearch.trim().toLowerCase();
  const visible = needle.length === 0
    ? rows
    : rows.filter((l) => l.name.toLowerCase().includes(needle));

  /*
   * No early return on an empty catalogue. The tool's sidebar shows "Create
   * list item" whether or not any list exists yet, and hiding the rail when
   * `lists` is empty would hide the only way to make the first one.
   */
  return (
    <aside
      ref={asideRef}
      id="mi-client-lists"
      className="mi-lists"
      aria-label="Client lists"
      style={{ width: `${width}px` }}
      // Says whether the streamed counts have landed. With no unread mail
      // there are no pills to look for, and "none yet" would look the same as
      // "never arrived" — to a person debugging and to the browser tests.
      data-unseen-counts={listCountsLater ? (lateCounts ? "ready" : "pending") : undefined}
      {...(collapsible
        ? {
            "data-collapsed": panel.collapsed ? "true" : "false",
            "data-drawer": panel.drawer ? "true" : "false",
            // Choosing a client leaves this screen; close the drawer on the
            // click rather than when the next screen has loaded.
            onClick: (e: React.MouseEvent<HTMLElement>) => {
              if (panel.drawer && e.target instanceof Element && e.target.closest("a")) closeClientsDrawer();
            },
          }
        : {})}
    >
      <div className="sec-h">Clients</div>

      {/* "All" clears the filter rather than being a list of its own. */}
      <InboxLink href={`/inbox/${view}`} className={`mi-list-item${activeListId ? "" : " on"}`}>
        <span className="mi-list-ind">
          <span className="mi-list-dot off" />
        </span>
        <span className="mi-list-name">All conversations</span>
      </InboxLink>

      {/* Search input — filters the lists below. Always visible above the
          scrollable lists area so it never falls off-screen. */}
      <div className="mi-list-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          // Chrome's autofill ignores most hints if a saved value
          // previously matched this slot — clients were getting
          // admin@outreachify.io dropped here, filtering every list
          // out. The readOnly-until-focus trick is the only reliable
          // way to suppress it: the field is non-targetable for the
          // browser's autofill heuristic at mount time, then becomes
          // editable the moment the user clicks in.
          name="sidebar-list-filter"
          autoComplete="off"
          inputMode="search"
          aria-autocomplete="none"
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
          readOnly
          onFocus={(e) => e.currentTarget.removeAttribute("readonly")}
          value={listSearch}
          onChange={(e) => setListSearch(e.target.value)}
          placeholder="Search lists…"
          aria-label="Search lists"
        />
      </div>

      {/* Clients by status — the tool's strip, in the same place. */}
      {counts ? (
        <div className="mi-list-counts" role="group" aria-label="Clients by status">
          {(["active", "paused", "churned"] as const).map((s) => (
            <span key={s} title={`${counts[s]} ${STATUS_LABEL[s].toLowerCase()} client${counts[s] === 1 ? "" : "s"}`}>
              <span className={`mi-list-dot s-${s}`} aria-hidden="true" />
              <span className="sr-only">{STATUS_LABEL[s]}: </span>
              {counts[s]}
            </span>
          ))}
        </div>
      ) : statusKnown ? null : (
        // Same height as the strip, nothing in it: the list below must not
        // jump down when the counts arrive.
        <div className="mi-list-counts" aria-hidden="true" style={{ visibility: "hidden" }}>
          <span>0</span>
        </div>
      )}

      {/* Scrollable lists area, so a long client catalogue scrolls inside
          the rail rather than pushing the search box off-screen. */}
      <div
        className="mi-lists-scroll"
        ref={listScrollRef}
        onScroll={(e) => { remembered.scrollTop = e.currentTarget.scrollTop; }}
      >
        {visible.map((l) => (
          <ClientListRow
            key={l.id}
            list={l}
            status={l.status}
            statusKnown={statusKnown}
            active={l.id === activeListId}
            unseen={unseenByList[l.id] ?? 0}
            href={`/inbox/${view}?list=${l.id}`}
            onEdit={() => setEditingList(l)}
            onDelete={() => setDeletingList(l)}
          />
        ))}

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="mi-list-item"
          style={{ width: "100%", border: 0, background: "none", font: "inherit", cursor: "pointer", color: "var(--muted)" }}
        >
          <Plus className="size-4 shrink-0" strokeWidth={2} />
          <span className="mi-list-name">Create list item</span>
        </button>
      </div>

      <CreateListDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CreateListDialog
        open={editingList !== null}
        onOpenChange={(v) => !v && setEditingList(null)}
        editing={editingList}
        onUpdated={() => {
          setEditingList(null);
          router.refresh();
        }}
      />
      <DeleteListDialog
        list={deletingList}
        onClose={() => setDeletingList(null)}
        onDeleted={() => {
          setDeletingList(null);
          router.refresh();
        }}
      />

      {/* Resize handle — right edge. Drawn like the prospect panel's grip. */}
      <div
        onPointerDown={onHandlePointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={`mi-lists-grip${resizing ? " drag" : ""}`}
      />
    </aside>
  );
}

/*
 * One row: the design's `.mi-list-item` link, with the tool's kebab menu laid
 * over its right edge. The menu is hidden until the row is hovered (or is the
 * active list), exactly as the tool's sidebar reveals it — the rail is a
 * column of names, and thirty-six always-visible menu buttons would compete
 * with them.
 */
function ClientListRow({
  list,
  status,
  statusKnown,
  active,
  unseen,
  href,
  onEdit,
  onDelete,
}: {
  list: ListRow;
  status: ClientStatus | null;
  /** False until the status feed has answered — see `statusKnown` above. */
  statusKnown: boolean;
  active: boolean;
  unseen: number;
  href: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative">
      <InboxLink
        href={href}
        className={`mi-list-item${active ? " on" : ""}`}
        title={status ? `${list.name} — ${status}` : list.name}
        // Room on the right for the menu button, so a long name ellipsises
        // before it rather than underneath it.
        style={{ paddingRight: 30 }}
      >
        {/* Fixed-width indicator slot so client names align whether the row
            shows a status dot or falls back to its folder icon. */}
        <span className="mi-list-ind">
          {status ? (
            <span
              className={`mi-list-dot s-${status}`}
              title={STATUS_LABEL[status]}
              aria-label={STATUS_LABEL[status]}
            />
          ) : statusKnown ? (
            <span className="mi-list-icon" aria-hidden="true">{list.icon ?? "📁"}</span>
          ) : (
            <span className="mi-list-dot off" aria-hidden="true" />
          )}
        </span>
        <span className="mi-list-name">{list.name}</span>
        {unseen > 0 ? (
          <span className="ml-auto shrink-0 inline-flex items-center rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white tabular-nums">
            {unseen > 99 ? "99+" : unseen} new
          </span>
        ) : null}
      </InboxLink>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="List actions"
              className={
                "absolute right-1 top-1/2 -translate-y-1/2 size-6 rounded flex items-center justify-center text-muted-foreground/60 hover:bg-background hover:text-foreground transition-opacity" +
                (active ? " opacity-100" : " opacity-0 group-hover:opacity-100 focus-visible:opacity-100")
              }
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start" className="text-sm">
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              onEdit();
            }}
          >
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              onDelete();
            }}
            className="text-red-600 focus:text-red-600"
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
