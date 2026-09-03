"use client";

import { useState } from "react";
import { NAV, type NavProduct } from "@/lib/workspace/nav";
import { BrandMark } from "@/components/layout/brand-mark";
import { ToolGlyph } from "./tool-glyph";

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
  badges?: Partial<Record<string, number>>;
  user: { name: string; email: string };
}

export function Rail({ grants, activeId, onNavigate, badges = {}, user }: RailProps) {
  // Which product's list is open. Starts closed: the rail opens the product you
  // navigate into, so a fresh session shows the short version.
  const [open, setOpen] = useState<string | null>(null);

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
        <BrandMark />
      </div>

      <div className="rail-scroll">
        {NAV.map((section) => {
          const items = section.items.filter(
            (item) => item.kind === "page" || grants.includes(item.id),
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
                    >
                      <ToolGlyph id={item.id} />
                      <span className="lbl">{item.label}</span>
                    </button>
                  );
                }
                return (
                  <Product
                    key={item.id}
                    product={item}
                    open={open === item.id}
                    activeId={activeId}
                    badges={badges}
                    onToggle={() => setOpen(open === item.id ? null : item.id)}
                    onNavigate={onNavigate}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="rail-foot">
        <span className="av">{initials}</span>
        <span className="who">
          <b>{user.name}</b>
          <span>{user.email}</span>
        </span>
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
  onNavigate,
}: {
  product: NavProduct;
  open: boolean;
  activeId: string;
  badges: Partial<Record<string, number>>;
  onToggle: () => void;
  onNavigate: (id: string) => void;
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
        <ToolGlyph id={product.id} />
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
