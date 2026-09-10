"use client";

import { useState, Fragment } from "react";
import { ChevronDown, Phone, Reply, MessageSquare } from "lucide-react";
import { cn } from "@/lib/tools/master-inbox/utils";
import {
  STAGE_DESCRIPTIONS,
  type PipelineStage,
} from "@/lib/tools/master-inbox/portals/stages-shared";
import {
  useStageLabels,
  useVisibleStages,
} from "@/components/master-inbox/portals-ui/stage-labels-context";

// Splits into three render targets:
//   <PipelineHeader>      → title + Nicole Collins intro (always visible)
//   <PipelineBoard>       → the table (in its own file)
//   <PipelineFooterInfo>  → collapsibles for Best Practices + Stage legend
//
// The intro copy used to live in the footer; it's been hoisted to the
// header so the user-supplied Nicole Collins photo can sit next to it
// the moment the page loads.

// Stage chip colour map mirrors the pipeline board so the legend reads
// as a direct lookup.
const LEGEND_STYLE: Record<PipelineStage, string> = {
  introduction: "bg-[#1976d2]",
  phone_screen_scheduled: "bg-[#7689e0]",
  phone_screen: "bg-[#4f63d2]",
  interview_scheduled: "bg-[#a98ff8]",
  interview: "bg-[#7c4dff]",
  hired: "bg-[#10a05d]",
  keep_warm: "bg-[#f5a623]",
  we_they_rejected: "bg-[#e23a3a]",
  no_show: "bg-[#8b95a3]",
};

// Surface every stage the CLIENT is allowed to see in the legend
// (per-client visible set via useVisibleStages — feature-flagged
// stages stay hidden until their flag is on for that client). The
// list is resolved inside PipelineFooterInfo at render time below.

const BEST_PRACTICES: Array<{ icon: typeof Reply; title: string; body: string }> = [
  {
    icon: Reply,
    title: "Reply to the intro email",
    body: "Acknowledge the introduction and confirm you’ll be calling them.",
  },
  {
    icon: MessageSquare,
    title: "Text the agent",
    body: "Confirm the call. Starting a text conversation has proven very effective.",
  },
  {
    icon: Phone,
    title: "Call the agent now",
    body: "Acknowledge the intro and lock in a specific time to talk further.",
  },
];

export function PipelineHeader({
  clientName,
}: {
  clientName: string;
}) {
  return (
    <header className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 sm:pt-8">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9aa0ab]">
        {clientName} · Recruiting Pipeline
      </div>
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-[#0f1320] sm:text-[26px]">
        Every introduction, end to end
      </h1>
      {/* Nicole Collins intro — sits directly under the title so the
          brokerage sees who's sending intros the moment the page loads.
          The photo file lives at /public/portal/nicole-collins.png.
          On a fresh deploy that hasn't dropped the asset in place yet,
          the <img> falls back to the initials block via the onError
          handler so the row never looks broken. */}
      <div className="mt-4 flex items-center gap-4 rounded-2xl border border-[#ebecf0] bg-white p-4 shadow-sm sm:p-5">
        <NicolePhoto />
        <p className="min-w-0 text-[13.5px] leading-relaxed text-[#5b6472]">
          <span className="font-medium text-[#0f1320]">Nicole Collins</span>{" "}
          (
          <a
            href="mailto:nicole.c@brokerstaffer.com"
            className="text-[#1565C0] hover:underline"
          >
            nicole.c@brokerstaffer.com
          </a>
          ), the Talent Acquisition Coordinator assigned to your account,
          will send all warm introductions via email. Please keep an eye
          out for messages from her, as this is how interested candidates
          will be introduced to you.
        </p>
      </div>
    </header>
  );
}

// 72px circular portrait — sized for a 1182×1182 PNG so the
// downscale stays crisp without overpowering the title row. Initials
// fallback in the brand palette covers the case where the static
// asset hasn't been dropped in yet on a fresh deploy.
function NicolePhoto() {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div
        aria-label="Nicole Collins"
        className="flex size-[72px] shrink-0 items-center justify-center rounded-full bg-[#eaf2fd] text-[18px] font-semibold text-[#1565C0]"
      >
        NC
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/portal/nicole-collins.png"
      alt="Nicole Collins"
      onError={() => setErrored(true)}
      className="size-[72px] shrink-0 rounded-full object-cover ring-1 ring-[#ebecf0]"
    />
  );
}

// Renders Best Practices + Stage legend BELOW the pipeline. Both are
// collapsibles (closed by default) so they don't push the data off-
// screen but stay discoverable for first-time users.
export function PipelineFooterInfo() {
  const stageLabels = useStageLabels();
  // Per-client visible stage list. Real clients see the eight
  // stages they've always seen; Demo Portal (with the feature flag)
  // sees the additional Interview Scheduled stage in this legend.
  const legendOrder = useVisibleStages();
  return (
    <section className="mx-auto mt-2 max-w-6xl px-4 pb-12 sm:px-6">
      <Disclosure
        title="Best practices when an intro lands"
        accent="bg-[#f4f9ff] border-[#d4e4f8]"
      >
        <ol className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {BEST_PRACTICES.map((b, i) => {
            const Icon = b.icon;
            return (
              <li
                key={b.title}
                className="flex items-start gap-3 rounded-xl border border-white/60 bg-white p-3"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#1565C0] text-[11px] font-semibold text-white">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[#0f1320]">
                    <Icon className="size-3.5 text-[#1565C0]" />
                    {b.title}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-snug text-[#5b6472]">
                    {b.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </Disclosure>

      <div className="mt-3">
        <Disclosure title="What each stage means">
          {/* The legend `ul` is a single CSS grid with a shared chip
              column. Auto-sizing the chip column to the widest chip
              across the whole list keeps every chip's left edge in line
              and every description starting at the same x. */}
          <ul className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 sm:grid-cols-[auto_1fr_auto_1fr]">
            {legendOrder.map((s) => (
              <Fragment key={s}>
                <span
                  className={cn(
                    "mt-0.5 inline-flex shrink-0 items-center justify-center self-start rounded-full px-2 py-0.5 text-center text-[10.5px] font-semibold text-white",
                    LEGEND_STYLE[s],
                  )}
                >
                  {stageLabels[s]}
                </span>
                <p className="text-[12.5px] leading-snug text-[#5b6472]">
                  {STAGE_DESCRIPTIONS[s]}
                </p>
              </Fragment>
            ))}
          </ul>
        </Disclosure>
      </div>
    </section>
  );
}

// Lightweight chevron-toggle card. Closed by default so the pipeline
// sits as the dominant element on the page; expanding either card is
// a one-tap nudge once a user wants the help text.
function Disclosure({
  title,
  children,
  accent,
}: {
  title: string;
  children: React.ReactNode;
  accent?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        "rounded-2xl border bg-white",
        accent ?? "border-[#ebecf0]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left sm:px-5"
        aria-expanded={open}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#1565C0]">
          {title}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-[#9aa0ab] transition-transform",
            open ? "rotate-180" : "",
          )}
        />
      </button>
      {open ? <div className="px-4 pb-4 sm:px-5 sm:pb-5">{children}</div> : null}
    </div>
  );
}
