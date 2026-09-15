"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
const SIDEBAR_WIDTH_KEY = "sales-inbox-sidebar-width";
const DEFAULT_WIDTH = 232;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export function ClientLists({
  lists,
  activeListId,
  view,
  listCounts = {},
}: {
  lists: ListRow[];
  activeListId: string | null;
  view: string;
  /** list id → count of unseen open threads; drives the "N new" pill. */
  listCounts?: Record<string, number>;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Record<string, ClientStatus>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [editingList, setEditingList] = useState<ListRow | null>(null);
  const [deletingList, setDeletingList] = useState<ListRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tools/master-inbox/clients/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json?.byName) return;
        /*
         * `byName` is already keyed by the normalised client name and already
         * narrowed to the three statuses — the route does that work once,
         * server-side, so every browser does not repeat it. An earlier version
         * of this component guessed at a `clients` array and silently found
         * nothing: the rail rendered with no dots and looked merely undecided
         * rather than broken.
         */
        setStatus(json.byName as Record<string, ClientStatus>);
      })
      .catch(() => {
        /* Fail open — no dots, inbox unaffected. See the note above. */
      });
    return () => { cancelled = true; };
  }, []);

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
    <aside className="mi-lists" aria-label="Client lists" style={{ width: `${width}px` }}>
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

      {/* Scrollable lists area, so a long client catalogue scrolls inside
          the rail rather than pushing the search box off-screen. */}
      <div className="mi-lists-scroll">
        {visible.map((l) => (
          <ClientListRow
            key={l.id}
            list={l}
            status={l.status}
            active={l.id === activeListId}
            unseen={listCounts[l.id] ?? 0}
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
  active,
  unseen,
  href,
  onEdit,
  onDelete,
}: {
  list: ListRow;
  status: ClientStatus | null;
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
          ) : (
            <span className="mi-list-icon" aria-hidden="true">{list.icon ?? "📁"}</span>
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
