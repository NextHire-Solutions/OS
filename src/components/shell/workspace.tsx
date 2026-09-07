"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Rail } from "./rail";
import { Topbar } from "./topbar";
import { Palette } from "./palette";
import { ToolPane } from "./tool-pane";
import { NAV, destinations, type Destination } from "@/lib/workspace/nav";

/*
 * The workspace frame: rail, top bar, and whatever is on stage.
 *
 * Navigation is client state rather than routing. Two reasons, and the second
 * is the one that matters:
 *
 *   1. the destinations are a fixed tree, not arbitrary URLs
 *   2. panes must stay MOUNTED when you switch away, so returning to a tool is
 *      instant and keeps its scroll position and unsent draft. A route change
 *      unmounts, which would reload a whole app on every visit
 *
 * The trade is no deep-linkable URL per screen. Worth revisiting once the tool
 * panes are live and someone wants to paste a link to one.
 */

export interface WorkspaceProps {
  grants: string[];
  user: { name: string; email: string };
  /** Absolute base URL per tool, resolved on the server. */
  toolUrls: Partial<Record<string, string>>;
  shellHost: string;
  badges?: Partial<Record<string, number>>;
  /** Workspace-owned screens, keyed by nav id. */
  screens: Partial<Record<string, React.ReactNode>>;
}

export function Workspace({
  grants,
  user,
  toolUrls,
  shellHost,
  badges,
  screens,
}: WorkspaceProps) {
  const [activeId, setActiveId] = useState("home");
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Panes are mounted on first visit and never unmounted, which is what makes
  // switching back instant. Capped below.
  const [mounted, setMounted] = useState<string[]>([]);

  const all = useMemo(() => destinations(), []);
  const reachable = useMemo(
    () => all.filter((d) => !d.tool || grants.includes(d.tool)),
    [all, grants],
  );

  const navigate = useCallback((id: string) => {
    setActiveId(id);
    setMounted((live) => {
      if (!id.includes(":")) return live;
      if (live.includes(id)) return [...live.filter((x) => x !== id), id];
      /*
       * Three live panes, evicting the least recently used.
       *
       * Four booted Next apps in four iframes is real memory on a laptop that
       * is also running the tools' own tabs. Three covers moving between a
       * pair of tools with a third in reserve, which is what people actually do.
       */
      return [...live, id].slice(-3);
    });
  }, []);

  // The design's shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("rail-collapsed", collapsed);
  }, [collapsed]);

  const active = reachable.find((d) => d.id === activeId);
  const crumbs = active ? [active.group, active.label] : ["Workspace", "Home"];

  useEffect(() => {
    document.title = `${crumbs[crumbs.length - 1]} — BrokerStaffer Workspace`;
  }, [crumbs]);

  const pick = useCallback(
    (d: Destination) => {
      setPaletteOpen(false);
      navigate(d.id);
    },
    [navigate],
  );

  return (
    <>
      <div className="app">
        <Rail
          grants={grants}
          activeId={activeId}
          onNavigate={navigate}
          badges={badges}
          user={user}
        />

        <main className="stage">
          <Topbar
            crumbs={crumbs}
            collapsed={collapsed}
            onToggleRail={() => setCollapsed((v) => !v)}
            onOpenPalette={() => setPaletteOpen(true)}
          />

          <div className="scroll">
            {/* Workspace-owned screens: rendered once, shown by id. */}
            {Object.entries(screens).map(([id, node]) => (
              <section key={id} className={`screen${activeId === id ? " on" : ""}`}>
                {node}
              </section>
            ))}

            {/* Tool panes: mounted on first visit, then kept warm. */}
            {mounted.map((id) => {
              const dest = reachable.find((d) => d.id === id);
              if (!dest?.tool) return null;
              return (
                <ToolPane
                  key={id}
                  active={activeId === id}
                  label={dest.label}
                  productLabel={dest.group}
                  baseUrl={toolUrls[dest.tool] ?? ""}
                  path={dest.path ?? "/"}
                  verified={dest.verified}
                  shellHost={shellHost}
                />
              );
            })}
          </div>
        </main>
      </div>

      <Palette
        open={paletteOpen}
        destinations={reachable}
        onClose={() => setPaletteOpen(false)}
        onPick={pick}
      />
    </>
  );
}

/** Every product in the tree, for the server to resolve URLs against. */
export function productIds(): string[] {
  return NAV.flatMap((s) => s.items)
    .filter((i) => i.kind === "product")
    .map((i) => i.id);
}
