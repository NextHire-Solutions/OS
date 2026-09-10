"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SessionKeeper } from "./session-keeper";
import { OutboxSweeper } from "./outbox-sweeper";
import { Rail } from "./rail";
import { Topbar } from "./topbar";
import { Palette } from "./palette";
import { ToolPane } from "./tool-pane";
import { NAV, destinations, idForPath, pathForId, type Destination } from "@/lib/workspace/nav";

/*
 * The workspace frame: rail, top bar, and whatever is on stage.
 *
 * Every screen has a real address — /inbox, /analytics, /team — so links can be
 * shared and the back button works.
 *
 * The URL is changed with history.pushState rather than a router navigation,
 * which is the crux of the whole shell: a route change would UNMOUNT the panes,
 * and a mounted pane is the only reason returning to a tool is instant with its
 * scroll position and unsent drafts intact. Reloading a whole application on
 * every sidebar click is exactly the feeling this design exists to remove.
 *
 * So: React state drives what is displayed, pushState keeps the address bar
 * honest, and popstate handles Back. The server reads the same path on a cold
 * load, so a pasted link renders the right screen immediately.
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
  /** Resolved from the URL on the server, so a pasted link lands correctly. */
  initialId?: string;
}

export function Workspace({
  grants,
  user,
  toolUrls,
  shellHost,
  badges,
  screens,
  initialId = "home",
}: WorkspaceProps) {
  const [activeId, setActiveId] = useState(initialId);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  /*
   * Panes are mounted on first visit and never unmounted, which is what makes
   * switching back instant. Capped below.
   *
   * Seeded from initialId, because arriving directly at /inbox has to mount
   * the pane too — mounting used to happen only inside navigate(), so a pasted
   * link rendered the shell with an empty stage and nothing to show.
   */
  const [mounted, setMounted] = useState<string[]>(() =>
    initialId.includes(":") && !(initialId in screens) ? [initialId] : [],
  );

  const all = useMemo(() => destinations(), []);
  const reachable = useMemo(
    () => all.filter((d) => !d.tool || grants.includes(d.tool)),
    [all, grants],
  );

  const router = useRouter();

  const navigate = useCallback((id: string, fromHistory = false) => {
    /*
     * Two kinds of destination, two kinds of navigation.
     *
     * IFRAME PANES stay warm: pushState only, because `router.push` would
     * unmount every mounted pane and reboot the app inside it.
     *
     * WORKSPACE SCREENS are server-rendered one at a time now, so reaching one
     * means asking the server for it. pushState alone would change the URL and
     * leave an empty stage.
     */
    const isWorkspaceScreen = id in screens;
    setActiveId(id);
    if (!fromHistory && typeof window !== "undefined") {
      const path = pathForId(id);
      if (window.location.pathname !== path) {
        if (isWorkspaceScreen) router.push(path);
        else window.history.pushState({ id }, "", path);
      }
    }
    setMounted((live) => {
      if (!id.includes(":") || id in screens) return live;
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
  }, [screens, router]);

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

  // Back and forward move between screens without reloading anything.
  useEffect(() => {
    function onPop() {
      setActiveId(idForPath(window.location.pathname));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
      {/* Renews the 30-minute sign-in while the workspace is open. Without it
          every session died mid-task and the next click bounced to /login. */}
      <SessionKeeper />
      {/* Retries introduction side effects a restart left behind. See the
          component for why this runs from the browser rather than a cron. */}
      <OutboxSweeper />
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
              {/*
               * ONLY THE ACTIVE SCREEN IS RENDERED.
               *
               * This used to render every screen and reveal one with CSS, so a
               * switch cost no round-trip. That was affordable while the screens
               * were small summaries. It stopped being affordable once they
               * became the Master Inbox's real pages: every request built all
               * sixteen, and the home page shipped 810KB containing the inbox,
               * the settings editors and — the part that decided it — every
               * client's live portal token, to anyone loading any page.
               *
               * One screen takes a page from ~12s to ~1s and stops it carrying
               * data it has no business carrying. The cost is that moving
               * between screens is a navigation rather than a class toggle;
               * `navigate` handles that, and the iframe panes below still use
               * pushState because those really are warm.
               */}
              {/*
               * The catch-all builds an element for the ACTIVE screen only and
               * `null` for the rest (see `pick` in app/[[...slug]]/page.tsx),
               * so rendering whatever is non-null renders exactly one.
               *
               * Membership checks above use `id in screens` rather than
               * truthiness: every key is present, so a null value means
               * "workspace screen, not currently built" — not "iframe pane".
               */}
              {Object.entries(screens)
                .filter(([, node]) => node != null)
                .map(([id, node]) => (
                  <section key={id} className="screen on">
                    {node}
                  </section>
                ))}

            {/*
              Panes are the FALLBACK. A destination the workspace draws itself
              is in `screens` above and never mounts an iframe — that is the
              architecture: the OS builds the product, and embeds only what it
              has not built yet.
            */}
            {mounted.map((id) => {
              const dest = reachable.find((d) => d.id === id);
              if (!dest?.tool || id in screens) return null;
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
