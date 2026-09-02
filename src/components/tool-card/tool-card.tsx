import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { hostname } from "@/lib/format";
import type { HealthState, ToolSnapshot } from "@/lib/connectors/types";
import { STATUS_LABEL } from "@/components/status/status-pip";
import { StatRow } from "./stat-row";
import { ToolIcon, toolAccent } from "./tool-icon";

/*
 * The card.
 *
 * Structurally an <article>, NOT an anchor — a link cannot contain links, and
 * the deep-link chips live inside it. The tool name is the real anchor and a
 * stretched ::after makes the whole rectangle clickable; chips sit above it on
 * z-index so they stay individually clickable. Tab order: title → chips → next.
 *
 * The launch link stays live in EVERY state, including `down`, and the card is
 * never dimmed — the first thing anyone does with a tool reported down is try
 * to open it, and `down` here often means "our probe lacked a credential"
 * rather than "the app is broken".
 */

/** A dot at rest; a dot and a word when there is something to say. Healthy is
 *  the default state of four cards out of five and does not need to shout. */
function StatusMark({ state, note }: { state: HealthState; note?: string }) {
  const dot: Record<HealthState, string> = {
    up: "bg-status-up",
    degraded: "bg-status-warn",
    down: "bg-status-down",
    unknown: "bg-status-neutral",
    unconfigured: "bg-status-neutral",
    checking: "bg-status-neutral",
  };

  const text: Record<HealthState, string> = {
    up: "text-muted-foreground",
    degraded: "text-status-warn-fg",
    down: "text-status-down-fg",
    unknown: "text-muted-foreground",
    unconfigured: "text-muted-foreground",
    checking: "text-muted-foreground",
  };

  return (
    <span
      role="status"
      title={note}
      className={cn("flex shrink-0 items-center gap-1.5 text-[11px] font-medium", text[state])}
    >
      <span className={cn("size-1.5 rounded-full", dot[state])} aria-hidden="true" />
      {state !== "up" ? <span aria-hidden="true">{STATUS_LABEL[state]}</span> : null}
      <span className="sr-only">
        {STATUS_LABEL[state]}
        {note ? `. ${note}` : ""}
      </span>
    </span>
  );
}

export function ToolCard({
  snapshot,
  index,
  className,
}: {
  snapshot: ToolSnapshot;
  index: number;
  className?: string;
}) {
  const titleId = `tool-${snapshot.id}-name`;

  const alert =
    snapshot.notes.find((n) => n.level === "error") ??
    snapshot.notes.find((n) => n.level === "warn");

  // Two chips, never three: a third wraps to a second line on the narrower
  // cards, which makes that card taller than its row-mates and the whole grid
  // look ragged. The rest are one ⌘K away.
  const chips = snapshot.deepLinks.filter((l) => l.verified).slice(0, 2);
  const hasStats = snapshot.metrics.length > 0;

  /*
   * A card with no numbers must not be a hollow box. When a tool exposes
   * nothing (Database) or we lack the credential to read it (Analytics), the
   * stat slot carries the honest fallback instead of empty space — which is
   * also why this is a sentence, not a row of em-dashes pretending data
   * failed to load.
   */
  const fallback = !hasStats
    ? snapshot.capabilities.hasMetrics
      ? "Connect a token to see live metrics"
      : snapshot.reachable && snapshot.latencyMs !== null
        ? `Responding in ${snapshot.latencyMs} ms`
        : "No metrics exposed"
    : null;

  return (
    // `display: contents` on the <li> makes the <article> the actual grid
    // child, so the column span has to land on the article, not here.
    <li className="contents">
      <article
        aria-labelledby={titleId}
        style={{ ...toolAccent(snapshot.id), animationDelay: `${Math.min(index, 5) * 28}ms` }}
        className={cn(
          "group cc-enter relative isolate flex flex-col rounded-2xl bg-surface p-5",
          "border border-border shadow-card",
          "transition-[transform,box-shadow,border-color] duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)]",
          "hover:-translate-y-1 hover:shadow-card-hover hover:border-[color-mix(in_oklch,var(--accent)_30%,var(--border))]",
          "active:translate-y-0 active:duration-[80ms]",
          "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
          className,
        )}
      >
        {/* Identity — icon beside the title rather than stacked above it, so
            the card stays compact and every title sits on the same baseline. */}
        <div className="flex items-start gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-[180ms] group-hover:scale-105"
            style={{ backgroundColor: "var(--accent-subtle)", color: "var(--accent)" }}
          >
            <ToolIcon id={snapshot.id} className="size-[18px]" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <h2
                id={titleId}
                className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em]"
              >
                <a
                  href={snapshot.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={snapshot.href === "#" ? undefined : hostname(snapshot.href)}
                  className="rounded-sm outline-none after:absolute after:inset-0 after:z-0 after:content-['']"
                >
                  {snapshot.name}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </h2>
              <StatusMark state={snapshot.state} note={alert?.text} />
            </div>

            {/* Clamped to two lines AND reserved at two lines, so a one-line
                description doesn't leave the stats below it sitting higher
                than the neighbouring card's. */}
            <p className="mt-1 line-clamp-2 min-h-[2.6em] text-[12.5px] leading-snug text-muted-foreground">
              {snapshot.description}
            </p>
          </div>
        </div>

        {/* Stats — fixed slot so all five cards share a baseline. */}
        <div className="mt-5 flex min-h-[44px] items-start">
          {hasStats ? (
            <StatRow metrics={snapshot.metrics} />
          ) : (
            <p className="text-[12.5px] leading-snug text-muted-foreground/70">{fallback}</p>
          )}
        </div>

        {/* Deep links stay visible: they are the reason this is a launcher and
            not a status page, and hiding them behind hover made every card
            look empty at rest. */}
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline pt-3.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {chips.map((link) => (
              <a
                key={link.id}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "relative z-10 rounded-md px-1.5 py-1 text-[11.5px] leading-none",
                  "text-muted-foreground transition-colors duration-[120ms]",
                  "hover:bg-surface-sunken hover:text-foreground",
                )}
              >
                {link.label}
              </a>
            ))}
          </div>

          <ArrowUpRight
            className="size-4 shrink-0 text-muted-foreground/60 transition-all duration-[180ms] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[color:var(--accent)]"
            aria-hidden="true"
          />
        </div>
      </article>
    </li>
  );
}
