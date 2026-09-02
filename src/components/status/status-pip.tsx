import { cn } from "@/lib/utils";
import type { HealthState } from "@/lib/connectors/types";

/*
 * The status vocabulary. Five states, each carried by THREE channels — glyph
 * shape, word, and colour — so the design survives losing any one of them.
 *
 * The four static shapes are distinguishable in grayscale at 10px by
 * silhouette alone: solid-round / pointed / round-with-a-hole / hollow-broken.
 * That is the accessibility guarantee; the word beside it is belt and braces.
 * It is also why status colours are allowed to sit below 3:1 on the light
 * surface — colour never carries the meaning by itself.
 *
 * `unknown` is the one to get right. Two of the five tools are black boxes and
 * will live in this state permanently, so it is NEUTRAL GREY, never amber.
 * Amber would claim something is wrong with the Database, which is false.
 */

export const STATUS_LABEL: Record<HealthState, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Down",
  unknown: "Unknown",
  unconfigured: "Not configured",
  checking: "Checking",
};

const TONE: Record<HealthState, string> = {
  up: "text-status-up-fg",
  degraded: "text-status-warn-fg",
  down: "text-status-down-fg",
  unknown: "text-status-neutral-fg",
  unconfigured: "text-status-neutral-fg",
  checking: "text-status-neutral-fg",
};

function Glyph({ state }: { state: HealthState }) {
  const common = { width: 10, height: 10, viewBox: "0 0 10 10", "aria-hidden": true } as const;

  switch (state) {
    case "up":
      // Solid round.
      return (
        <svg {...common} className="shrink-0 fill-status-up">
          <circle cx="5" cy="5" r="4" />
        </svg>
      );
    case "degraded":
      // Pointed — reads as a warning triangle even with no colour.
      return (
        <svg {...common} className="shrink-0 fill-status-warn">
          <path d="M5 0.6 L9.6 8.8 H0.4 Z" />
        </svg>
      );
    case "down":
      // Round with a hole punched through it.
      return (
        <svg {...common} className="shrink-0 fill-status-down">
          <path
            fillRule="evenodd"
            d="M5 1a4 4 0 100 8 4 4 0 000-8zM3.4 3.4a.6.6 0 01.85 0L5 4.15l.75-.75a.6.6 0 11.85.85L5.85 5l.75.75a.6.6 0 11-.85.85L5 5.85l-.75.75a.6.6 0 01-.85-.85L4.15 5l-.75-.75a.6.6 0 010-.85z"
          />
        </svg>
      );
    case "checking":
      // Hollow and moving. Under prefers-reduced-motion the global rule stops
      // the spin and it becomes a static broken ring — still distinct.
      return (
        <svg {...common} className="cc-spin shrink-0 stroke-status-neutral" fill="none">
          <circle cx="5" cy="5" r="3.6" strokeWidth="1.6" strokeDasharray="17 6" strokeLinecap="round" />
        </svg>
      );
    default:
      // Hollow with a broken edge — visibly "no signal", not "bad signal".
      return (
        <svg {...common} className="shrink-0 stroke-status-neutral" fill="none">
          <circle cx="5" cy="5" r="3.6" strokeWidth="1.4" strokeDasharray="2.6 2.2" />
        </svg>
      );
  }
}

export function StatusPip({
  state,
  className,
  srDetail,
}: {
  state: HealthState;
  className?: string;
  /** Extra timing detail for screen readers that would clutter the card. */
  srDetail?: string;
}) {
  return (
    <span
      role="status"
      className={cn("inline-flex items-center gap-1.5 text-[11px] font-semibold", TONE[state], className)}
    >
      <Glyph state={state} />
      <span aria-hidden="true">{STATUS_LABEL[state]}</span>
      <span className="sr-only">
        {STATUS_LABEL[state]}.{srDetail ? ` ${srDetail}` : ""}
      </span>
    </span>
  );
}
