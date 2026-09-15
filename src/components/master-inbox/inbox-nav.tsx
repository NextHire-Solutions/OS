"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";

import { InboxSkeleton } from "@/components/master-inbox/inbox-skeleton";

/*
 * In-screen navigation feedback for the Master Inbox.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TOOL DOES
 *
 * The deployed tool has `app/(app)/inbox/[view]/loading.tsx` and
 * `[view]/[threadId]/loading.tsx`, each rendering `InboxSkeleton`. Next paints
 * that skeleton the instant any navigation into a list or a thread starts and
 * keeps it up until the server's loaders resolve — so a click never leaves
 * the OLD page frozen on screen for the full round trip, which is what the
 * team read as "it takes 5+ seconds to open a conversation".
 *
 * ---------------------------------------------------------------------------
 * WHY THE WORKSPACE CANNOT DO IT THE SAME WAY
 *
 * Every OS screen is served by one catch-all route, so there is no inbox
 * route segment to hang a `loading.tsx` on. The shell already solves this for
 * RAIL clicks (`src/components/shell/workspace.tsx`): `startTransition` around
 * `router.push`, the transition's `isPending` flag, and a skeleton that waits
 * 150ms before appearing so a fast navigation never flashes one.
 *
 * This file is that pattern applied to navigations that start INSIDE the
 * inbox — view tabs, list links, thread rows, the pager, search hits — which
 * bypass the shell's `navigate` entirely because they are plain `<Link>`s.
 *
 *   · `InboxNavProvider` wraps a screen. It owns the transition and, while a
 *     navigation is pending past 150ms, shows `InboxSkeleton` in place of the
 *     screen. The screen stays MOUNTED but hidden, exactly as the shell keeps
 *     its sections mounted, so nothing in it is thrown away if the response
 *     arrives quickly.
 *
 *   · `InboxLink` is `next/link` with one difference: a plain left click is
 *     routed through the provider's transition instead of Link's own, so the
 *     provider can see it pending. Modified clicks (cmd/ctrl/shift/alt), other
 *     buttons and `target` links are left to the browser, and prefetching is
 *     still Link's. Outside a provider it is just `<Link>`.
 *
 *   · `useInboxNav()` is for the few places that navigate imperatively
 *     (`router.push` for a page change or a search). Outside a provider it
 *     falls back to `router.push`, so the components stay usable anywhere.
 */

interface InboxNav {
  navigate: (href: string) => void;
  pending: boolean;
}

const InboxNavContext = createContext<InboxNav | null>(null);

/* The shell's own delay: a skeleton for a 250ms navigation is worse than
   showing nothing at all. */
const SKELETON_DELAY_MS = 150;

export function InboxNavProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (!isPending) {
      setShowSkeleton(false);
      return;
    }
    const t = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [isPending]);

  const navigate = useCallback(
    (href: string) => {
      startTransition(() => router.push(href));
    },
    [router, startTransition],
  );

  const value = useMemo<InboxNav>(() => ({ navigate, pending: isPending }), [navigate, isPending]);

  return (
    <InboxNavContext.Provider value={value}>
      {/*
        Both wrappers are `display: contents` (mi-inbox.css) so TopBar, TabBar
        and the split stay direct flex children of `.mi-theme`, as they were
        before this wrapper existed. `hidden` on the stage wins over that.
      */}
      {showSkeleton ? (
        <div className="mi-nav-skel" aria-busy="true" data-inbox-skeleton="">
          <InboxSkeleton />
        </div>
      ) : null}
      <div className="mi-nav-stage" hidden={showSkeleton}>
        {children}
      </div>
    </InboxNavContext.Provider>
  );
}

export function useInboxNav(): InboxNav {
  const ctx = useContext(InboxNavContext);
  const router = useRouter();
  const fallback = useMemo<InboxNav>(
    () => ({ navigate: (href) => router.push(href), pending: false }),
    [router],
  );
  return ctx ?? fallback;
}

type InboxLinkProps = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

/*
 * No viewport prefetch, hover prefetch instead.
 *
 * Every conversation row is one of these, and Link's default prefetches each
 * one as it scrolls into view: fifty rows, fifty server renders of a thread
 * page nobody asked for. Measured on production, switching to All Email
 * fired seven of them at once, each 0.8–1.6s of server time, and the list's
 * own request — 0.9s on its own — took 2.4s behind them. Prefetching on hover
 * keeps the instant open for the row a person is actually reaching for.
 */
export function InboxLink({ href, onClick, target, onMouseEnter, prefetch, ...rest }: InboxLinkProps) {
  const ctx = useContext(InboxNavContext);
  const router = useRouter();

  function handleMouseEnter(e: MouseEvent<HTMLAnchorElement>) {
    onMouseEnter?.(e);
    if (prefetch === false || href === "#") return;
    router.prefetch(href);
  }

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (!ctx || e.defaultPrevented) return;
    // Leave new-tab, new-window and non-primary clicks to the browser.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (target && target !== "_self") return;
    // A disabled pager link points at "#" — nothing to navigate to.
    if (href === "#") return;
    e.preventDefault();
    ctx.navigate(href);
  }

  return (
    <Link
      href={href}
      target={target}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      prefetch={prefetch === undefined ? false : prefetch}
      {...rest}
    />
  );
}
