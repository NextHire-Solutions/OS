import { cn } from "@/lib/tools/master-inbox/utils";

// Single source of truth for the per-lead "Source" pill rendered
// across the Recruiting Pipeline (list row, mobile card, Kanban
// card, detail sheet). Same shape, same colour rule, every surface.
//
// Colour rules:
//   • "BrokerStaffer" → brand-blue tones (`#1565C0` on `#eaf2fd`),
//     matching the active stage chip + "In Follow Up Boss" chip
//     elsewhere in the portal.
//   • "Client Entry" → neutral grey (`#5b6472` on `#f0f1f4`).
//   • Anything else → neutral grey too, so a future source value
//     (Referral, Event, …) renders sensibly without code changes.
//
// Visual style matches the other inline chips in the row
// (PushToFubChip, "Agent profile" link, etc.) — `text-[11.5px]`
// `font-medium`, rounded full pill. Caller is responsible for
// gating render on the `pipeline_source_split` flag.

export function SourceBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  if (!value) return null;
  const tone = toneFor(value);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone,
        className,
      )}
    >
      {value}
    </span>
  );
}

function toneFor(value: string): string {
  if (value === "BrokerStaffer") {
    return "bg-[#eaf2fd] text-[#1565C0]";
  }
  return "bg-[#f0f1f4] text-[#5b6472]";
}
