import { Inbox, HeartPulse, ChartNoAxesColumn, Database, Radar } from "lucide-react";
import type { ToolId } from "@/lib/connectors/types";

const ICONS: Record<ToolId, typeof Inbox> = {
  "master-inbox": Inbox,
  "client-health": HeartPulse,
  analytics: ChartNoAxesColumn,
  database: Database,
  scraper: Radar,
};

/**
 * Per-tool accent, resolved to the CSS variables in brand.css.
 *
 * Returned as inline custom properties rather than Tailwind classes because
 * the token name is dynamic — `bg-tool-${id}-subtle` would not survive
 * Tailwind's static class extraction.
 */
export function toolAccent(id: ToolId) {
  return {
    "--accent": `var(--tool-${id})`,
    "--accent-subtle": `var(--tool-${id}-subtle)`,
  } as React.CSSProperties;
}

export function ToolIcon({ id, className }: { id: ToolId; className?: string }) {
  const Icon = ICONS[id] ?? Database;
  return <Icon className={className} strokeWidth={2} aria-hidden="true" />;
}
