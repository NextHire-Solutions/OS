"use client";

import { useEffect, useRef, useState } from "react";
import { NAV, sectionKey, sectionOf, type NavProduct } from "@/lib/workspace/nav";
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
}

/**
 * The rail section a destination id belongs to — `"inbox:portals"` →
 * `"inbox"`, `"analytics:campaigns"` → `"campaign-management"` (one tool, two
 * sections since 9 Oct). Workspace pages belong to no section and give null.
 */
const productOf = sectionOf;

export function Rail({ grants, activeId, onNavigate, onPrefetch, badges = {}, user, admin = false, roles = {} }: RailProps) {
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

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside className="rail" id="rail">
      <div className="rail-head">
        <RailBrand />
      </div>

      <div className="rail-scroll">
        {NAV.map((section) => {
          const items = section.items.filter(
            (item) => item.kind === "page" ? canSeePage(item.id, admin, grants, ALL_TOOLS, roles) : grants.includes(item.id),
          );
          // A section whose every item is ungranted renders nothing at all —
          // not an empty heading, which would advertise what someone cannot have.
          if (items.length === 0) return null;

          return (
            <div className="sec" key={section.label}>
              <div className="sec-h">{section.label}</div>

              {items.map((item) => {
                if (item.kind === "page") {
                  return (
                    <button
                      key={item.id}
                      className={`nav${activeId === item.id ? " on" : ""}`}
                      data-tip={item.label}
                      onClick={() => onNavigate(item.id)}
                      onMouseEnter={() => onPrefetch?.(item.id)}
                      onFocus={() => onPrefetch?.(item.id)}
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
    </aside>
  );
}

function Product({
  product,
  open,
  activeId,
  badges,
  onToggle,
  onNavigate, onPrefetch,
}: {
  product: NavProduct;
  open: boolean;
  activeId: string;
  badges: Partial<Record<string, number>>;
  onToggle: () => void;
  onNavigate: (id: string) => void;
  /** Warms a destination before it is clicked. See workspace.tsx. */
  onPrefetch?: (id: string) => void;
}) {
  const holdsActive = product.children.some((c) => `${product.id}:${c.id}` === activeId);

  return (
    <div className={`acc${open ? " open" : ""}${holdsActive ? " has-active" : ""}`}>
      <button
        className="acc-btn"
        type="button"
        aria-expanded={open}
        data-tip={product.label}
        onClick={onToggle}
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
