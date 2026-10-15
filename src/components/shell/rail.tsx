"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NAV, sectionKey, sectionOf, type NavPage, type NavProduct } from "@/lib/workspace/nav";
import { RailBrand } from "./rail-brand";
import { ToolGlyph } from "./tool-glyph";
import { canSeePage, type RoleFlags } from "@/lib/workspace/nav";
import { ALL_TOOLS } from "@/lib/bs-auth";

/*
 * The left rail.
 *
 * Markup and class names follow the design file exactly, so its stylesheet
 * drives this without a translation layer — a class renamed here and not there
 * would silently lose styling, which is the usual way a faithful design turns
 * into an approximate one.
 *
 * One product is expanded at a time. With four products carrying 21 leaves
 * between them, letting them all open turns a scannable rail into a scrolling
 * one; and a rail you have to scroll defeats the point of hoisting every tool's
 * navigation into it.
 */

export interface RailProps {
  /** Tools this person may open. Anything else is not rendered at all. */
  grants: string[];
  activeId: string;
  onNavigate: (id: string) => void;
  /** Warms a destination before it is clicked. See workspace.tsx. */
  onPrefetch?: (id: string) => void;
  badges?: Partial<Record<string, number>>;
  user: { name: string; email: string };
  /** An owner or a marked admin — sees the admin-only pages. */
  admin?: boolean;
  /** Account manager / salesperson: fewer pages (Eddy, 2 Oct). */
  roles?: RoleFlags;
  /** The rail is retracted to its 76px icon strip. */
  collapsed?: boolean;
}

/*
 * What the retracted rail shows beside an icon (13 Oct: "Side Menu OS: when
 * retracted, it's broken").
 *
 * It was broken in two ways, both invisible in the stylesheet:
 *
 *   · A product's icon did NOTHING. Its click toggles the list underneath,
 *     and the retracted rail hides every list — so Master Inbox, Client
 *     Portals, Client Health, both Campaign sections and Agent Search could
 *     not be opened at all without expanding the rail first.
 *   · The hover label never showed. It is a CSS ::after positioned outside the
 *     rail, and the rail's scroller clips sideways (overflow-x) — it was drawn
 *     and cut off.
 *
 * So the retracted rail gets one fly-out, drawn in a portal on <body> where
 * nothing can clip it: for a product, its name and its screens, each a click
 * away; for a single page, just its name.
 */
interface Fly {
  key: string;
  label: string;
  /** Top of the icon, in the viewport. */
  top: number;
  /** A product's screens; null for a single page (a plain label). */
  leaves: Array<{ id: string; label: string; count?: number }> | null;
}

/** The retracted rail's width — `body.rail-collapsed .app` in shell.css. */
const COLLAPSED_WIDTH = 76;

/**
 * The rail section a destination id belongs to — `"inbox:archive"` →
 * `"inbox"`, `"analytics:campaigns"` → `"campaign-management"` (one tool, two
 * sections since 9 Oct). Workspace pages belong to no section and give null.
 */
const productOf = sectionOf;

export function Rail({ grants, activeId, onNavigate, onPrefetch, badges = {}, user, admin = false, roles = {}, collapsed = false }: RailProps) {
  /*
   * Which product's list is open.
   *
   * This used to start `null` and change only on click, while the comment here
   * claimed "the rail opens the product you navigate into". It did not — not on
   * a direct load. Opening /inbox/all-email from a pasted link, a bookmark, a
   * reload, or the deployed entry point left every accordion shut, so the rail
   * did not show which section you were in, `aria-expanded` said false on the
   * screen you were actually looking at, and the unread badge — which lives on
   * the All Email leaf — was hidden inside a closed list.
   *
   * So it now starts open on the active product, and follows you when you move
   * to a different one. Toggling stays manual within a product: collapsing the
   * list you are in keeps it collapsed rather than springing back on the next
   * render.
   */
  const [open, setOpen] = useState<string | null>(() => productOf(activeId));

  const lastProduct = useRef<string | null>(productOf(activeId));
  useEffect(() => {
    const product = productOf(activeId);
    if (product && product !== lastProduct.current) setOpen(product);
    lastProduct.current = product;
  }, [activeId]);

  const [fly, setFly] = useState<Fly | null>(null);
  const flyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const [flyTop, setFlyTop] = useState(0);
  const keepFly = useCallback(() => {
    if (flyTimer.current) clearTimeout(flyTimer.current);
    flyTimer.current = null;
  }, []);
  /** The icon the fly-out belongs to — where focus returns on Escape. */
  const flyAnchor = useRef<HTMLElement | null>(null);
  /** Set while focus is handed back to an icon by Escape, so that does not reopen its menu. */
  const quietFocus = useRef(false);
  const showFly = useCallback((el: HTMLElement, next: Omit<Fly, "top">) => {
    if (quietFocus.current) return;
    keepFly();
    flyAnchor.current = el;
    setFly({ ...next, top: el.getBoundingClientRect().top });
  }, [keepFly]);
  /*
   * Keyboard. The fly-out is portalled to the end of <body>, so Tab from an
   * icon goes to the next icon, not into the menu. Right or Down enters it;
   * Up/Down move through it; Left or Escape goes back to the icon.
   */
  const flyItems = () => [...(flyRef.current?.querySelectorAll<HTMLElement>(".rail-fly-i") ?? [])];
  const onRailKey = (e: React.KeyboardEvent) => {
    if (!collapsed || !fly?.leaves) return;
    // Keys pressed INSIDE the menu arrive here too (a portal's events bubble
    // to its React parent); those are the menu's own business.
    if (flyRef.current?.contains(e.target as Node)) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowDown") return;
    const first = flyItems()[0];
    if (!first) return;
    e.preventDefault();
    keepFly();
    first.focus();
  };
  const onFlyKey = (e: React.KeyboardEvent) => {
    const items = flyItems();
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
      next?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const back = flyAnchor.current;
      closeFly();
      quietFocus.current = true;
      back?.focus();
      quietFocus.current = false;
    }
  };
  // A short grace period, so the pointer can cross the gap from icon to menu.
  const hideFlySoon = useCallback(() => {
    keepFly();
    flyTimer.current = setTimeout(() => setFly(null), 160);
  }, [keepFly]);
  const closeFly = useCallback(() => {
    keepFly();
    setFly(null);
  }, [keepFly]);

  // Expanding the rail, or moving to another screen, puts the fly-out away.
  useEffect(() => {
    if (!collapsed) closeFly();
  }, [collapsed, closeFly]);
  useEffect(() => closeFly(), [activeId, closeFly]);
  useEffect(() => {
    if (!fly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFly();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (flyRef.current?.contains(t) || document.getElementById("rail")?.contains(t))) return;
      closeFly();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [fly, closeFly]);
  // Kept on screen: a menu opened from the last icon would run off the bottom.
  useLayoutEffect(() => {
    if (!fly) return;
    const h = flyRef.current?.offsetHeight ?? 0;
    setFlyTop(Math.max(8, Math.min(fly.top, window.innerHeight - h - 8)));
  }, [fly]);

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside className="rail" id="rail" onKeyDown={onRailKey}>
      <div className="rail-head">
        <RailBrand />
      </div>

      <div className="rail-scroll">
        {NAV.map((section) => {
          const items = section.items.filter(
            // A section with a switch of its own (Campaign Management, Inboxes — 15 Oct) follows it.
            (item) => item.kind === "page" ? canSeePage(item.id, admin, grants, ALL_TOOLS, roles) : grants.includes(item.grant ?? item.id),
          );
          // A section whose every item is ungranted renders nothing at all —
          // not an empty heading, which would advertise what someone cannot have.
          if (items.length === 0) return null;

          return (
            <div className="sec" key={section.label}>
              <div className="sec-h">{section.label}</div>

              {items.map((item) => {
                if (item.kind === "page" && item.children) {
                  return (
                    <PageGroup
                      key={item.id}
                      page={item}
                      leaves={item.children.filter((c) => canSeePage(c.id, admin, grants, ALL_TOOLS, roles))}
                      open={open === item.id}
                      activeId={activeId}
                      onToggle={() => setOpen(open === item.id ? null : item.id)}
                      onOpen={() => setOpen(item.id)}
                      onNavigate={onNavigate}
                      onPrefetch={onPrefetch}
                      collapsed={collapsed}
                      flyOpen={fly?.key === item.id}
                      onFly={showFly}
                      onFlyLeave={hideFlySoon}
                      onFlyClose={closeFly}
                    />
                  );
                }
                if (item.kind === "page") {
                  return (
                    <button
                      key={item.id}
                      className={`nav${activeId === item.id ? " on" : ""}`}
                      data-tip={item.label}
                      aria-label={item.label}
                      onClick={() => onNavigate(item.id)}
                      onMouseEnter={(e) => {
                        onPrefetch?.(item.id);
                        if (collapsed) showFly(e.currentTarget, { key: item.id, label: item.label, leaves: null });
                      }}
                      onMouseLeave={collapsed ? hideFlySoon : undefined}
                      onFocus={(e) => {
                        onPrefetch?.(item.id);
                        if (collapsed) showFly(e.currentTarget, { key: item.id, label: item.label, leaves: null });
                      }}
                      onBlur={collapsed ? hideFlySoon : undefined}
                    >
                      <ToolGlyph id={item.id} />
                      <span className="lbl">{item.label}</span>
                    </button>
                  );
                }
                const key = sectionKey(item);
                return (
                  <Product
                    key={key}
                    product={item}
                    open={open === key}
                    activeId={activeId}
                    badges={badges}
                    onToggle={() => setOpen(open === key ? null : key)}
                    onNavigate={onNavigate}
                    onPrefetch={onPrefetch}
                    collapsed={collapsed}
                    flyOpen={fly?.key === key}
                    onFly={showFly}
                    onFlyLeave={hideFlySoon}
                    onFlyClose={closeFly}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="rail-foot">
        {/* The person's own page: password today, more later. A plain link —
            the shell's client navigation covers product screens; this one is
            rare enough that a full load is fine and keeps the rail simple. */}
        <a href="/account" className="rail-account" title="Account" aria-label="Account settings" style={{ display: "contents", color: "inherit", textDecoration: "none" }}>
          <span className="av">{initials}</span>
          <span className="who">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </span>
        </a>

        {/*
          Sign out.
          
          There was no way to sign out of this workspace at all — the route
          `/api/auth/logout` has existed since the shell was built and nothing
          ever called it. On a shared machine that is not a missing convenience,
          it is the only way to hand the screen to a colleague.

          A form POST rather than a fetch: it works with JavaScript disabled,
          the browser follows the redirect the route already returns, and there
          is no client state to clear afterwards because the session lives in
          an HttpOnly cookie the server drops.
        */}
        <form action="/api/auth/logout" method="post" className="rail-signout">
          <button type="submit" className="ib" title="Sign out" aria-label="Sign out">
            <svg viewBox="0 0 24 24">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="m16 17 5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
        </form>
      </div>

      {collapsed && fly && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={flyRef}
              className={`rail-fly${fly.leaves ? "" : " rail-fly-tip"}`}
              // A page's label is decoration — its icon already carries the
              // name as aria-label — so it has no role (and a stylesheet here
              // re-centres anything with role="tooltip", which moved it over
              // the icons).
              role={fly.leaves ? "menu" : undefined}
              aria-hidden={fly.leaves ? undefined : true}
              aria-label={fly.leaves ? fly.label : undefined}
              data-rail-fly={fly.key}
              style={{ top: flyTop, left: COLLAPSED_WIDTH + 4 }}
              onMouseEnter={keepFly}
              onMouseLeave={hideFlySoon}
              onFocus={keepFly}
              onBlur={hideFlySoon}
              onKeyDown={onFlyKey}
            >
              <div className="rail-fly-h">{fly.label}</div>
              {fly.leaves?.map((leaf) => (
                <button
                  key={leaf.id}
                  type="button"
                  role="menuitem"
                  className={`rail-fly-i${activeId === leaf.id ? " on" : ""}`}
                  onClick={() => {
                    closeFly();
                    onNavigate(leaf.id);
                  }}
                  onMouseEnter={() => onPrefetch?.(leaf.id)}
                  onFocus={() => onPrefetch?.(leaf.id)}
                >
                  <span>{leaf.label}</span>
                  {typeof leaf.count === "number" && leaf.count > 0 ? <span className="pill">{leaf.count}</span> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
}

/** What a product or page group needs to drive the retracted rail's fly-out. */
interface FlyProps {
  collapsed: boolean;
  flyOpen: boolean;
  onFly: (el: HTMLElement, next: Omit<Fly, "top">) => void;
  onFlyLeave: () => void;
  onFlyClose: () => void;
}

/*
 * A workspace page with sub-pages under an arrow (9 Oct: Performance →
 * Overview, Billing Calendar). Drawn exactly like a product's list. One
 * difference: from outside the page, clicking its name OPENS it (Overview) as
 * well as the list — a product's name only toggles, but Performance was a
 * plain link until now, and its list is hidden when the rail is collapsed.
 */
function PageGroup({
  page,
  leaves,
  open,
  activeId,
  onToggle,
  onOpen,
  onNavigate, onPrefetch,
  collapsed, flyOpen, onFly, onFlyLeave, onFlyClose,
}: {
  page: NavPage;
  leaves: { id: string; label: string }[];
  open: boolean;
  activeId: string;
  onToggle: () => void;
  onOpen: () => void;
  onNavigate: (id: string) => void;
  onPrefetch?: (id: string) => void;
} & FlyProps) {
  const holdsActive = leaves.some((l) => l.id === activeId);
  const fly = { key: page.id, label: page.label, leaves };
  return (
    <div className={`acc${open ? " open" : ""}${holdsActive ? " has-active" : ""}`}>
      <button
        className="acc-btn"
        type="button"
        aria-expanded={collapsed ? flyOpen : open}
        aria-haspopup={collapsed ? "menu" : undefined}
        aria-label={page.label}
        data-tip={page.label}
        onClick={(e) => {
          // Retracted: the list has nowhere to open, so the click opens the
          // page itself (as it always has from outside) and shows its menu.
          if (collapsed) {
            onFly(e.currentTarget, fly);
            if (!holdsActive) onNavigate(leaves[0]?.id ?? page.id);
            return;
          }
          if (holdsActive) return onToggle();
          onOpen();
          onNavigate(leaves[0]?.id ?? page.id);
        }}
        onMouseEnter={(e) => {
          onPrefetch?.(leaves[0]?.id ?? page.id);
          if (collapsed) onFly(e.currentTarget, fly);
        }}
        onMouseLeave={collapsed ? onFlyLeave : undefined}
        onFocus={collapsed ? (e) => onFly(e.currentTarget, fly) : undefined}
        onBlur={collapsed ? onFlyLeave : undefined}
      >
        <ToolGlyph id={page.id} />
        <span className="lbl">{page.label}</span>
        <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      <div className="acc-body">
        <div className="acc-inner">
          <div className="acc-list">
            {leaves.map((leaf) => (
              <button
                key={leaf.id}
                className={`nav leaf${activeId === leaf.id ? " on" : ""}`}
                onClick={() => onNavigate(leaf.id)}
                onMouseEnter={() => onPrefetch?.(leaf.id)}
                onFocus={() => onPrefetch?.(leaf.id)}
              >
                <span className="lbl">{leaf.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Product({
  product,
  open,
  activeId,
  badges,
  onToggle,
  onNavigate, onPrefetch,
  collapsed, flyOpen, onFly, onFlyLeave, onFlyClose,
}: {
  product: NavProduct;
  open: boolean;
  activeId: string;
  badges: Partial<Record<string, number>>;
  onToggle: () => void;
  onNavigate: (id: string) => void;
  /** Warms a destination before it is clicked. See workspace.tsx. */
  onPrefetch?: (id: string) => void;
} & FlyProps) {
  const holdsActive = product.children.some((c) => `${product.id}:${c.id}` === activeId);
  const fly = {
    key: sectionKey(product),
    label: product.label,
    leaves: product.children.map((c) => ({
      id: `${product.id}:${c.id}`,
      label: c.label,
      count: c.badgeKey ? badges[c.badgeKey] : undefined,
    })),
  };

  return (
    <div className={`acc${open ? " open" : ""}${holdsActive ? " has-active" : ""}`}>
      <button
        className="acc-btn"
        type="button"
        aria-expanded={collapsed ? flyOpen : open}
        aria-haspopup={collapsed ? "menu" : undefined}
        aria-label={product.label}
        data-tip={product.label}
        onClick={(e) => {
          // Retracted: toggling a list nobody can see did nothing at all. The
          // click shows the product's screens beside the icon instead. It
          // never closes them: the pointer arriving has usually opened the
          // menu already, and a click that then shut it would look broken
          // all over again. Escape, a click elsewhere or moving away closes.
          if (!collapsed) return onToggle();
          onFly(e.currentTarget, fly);
        }}
        onMouseEnter={collapsed ? (e) => onFly(e.currentTarget, fly) : undefined}
        onMouseLeave={collapsed ? onFlyLeave : undefined}
        onFocus={collapsed ? (e) => onFly(e.currentTarget, fly) : undefined}
        onBlur={collapsed ? onFlyLeave : undefined}
      >
        <ToolGlyph id={sectionKey(product)} />
        <span className="lbl">{product.label}</span>
        <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      <div className="acc-body">
        <div className="acc-inner">
          <div className="acc-list">
            {product.children.map((leaf) => {
              const id = `${product.id}:${leaf.id}`;
              const count = leaf.badgeKey ? badges[leaf.badgeKey] : undefined;
              return (
                <button
                  key={id}
                  className={`nav leaf${activeId === id ? " on" : ""}`}
                  onClick={() => onNavigate(id)}
                  onMouseEnter={() => onPrefetch?.(id)}
                  onFocus={() => onPrefetch?.(id)}
                  // Says so rather than letting the pane look broken: these
                  // paths are not confirmed against the running app.
                  title={leaf.verified ? undefined : `${leaf.label} — opens the tool's default view`}
                >
                  <span className="lbl">{leaf.label}</span>
                  {typeof count === "number" && count > 0 ? (
                    <span className="pill">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
