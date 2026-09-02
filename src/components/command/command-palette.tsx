"use client";

import { useEffect, useMemo } from "react";
import { Command } from "cmdk";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolSnapshot } from "@/lib/connectors/types";
import { ToolIcon } from "@/components/tool-card/tool-icon";
import { StatusPip } from "@/components/status/status-pip";

/*
 * ⌘K palette.
 *
 * Two rules from hard experience baked in here:
 *  - The panel sits at 15vh, not vertically centred. Command palettes belong
 *    high; centring makes them feel like alert dialogs.
 *  - The highlighted row has NO transition. Animating the selected row turns
 *    held-arrow navigation into smearing, which is the single most common
 *    command-palette mistake.
 *
 * Status is shown beside each tool because that is what lets you decide NOT to
 * open a degraded tool without leaving the keyboard.
 */

function openTool(href: string, sameTab = false) {
  if (href === "#") return;
  if (sameTab) window.location.href = href;
  else window.open(href, "_blank", "noopener,noreferrer");
}

export function CommandPalette({
  open,
  onOpenChange,
  snapshots,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshots: ToolSnapshot[];
  onRefresh: () => void;
}) {
  // ⌘K toggles; ⌘1–⌘5 launch tool N whether the palette is open or closed.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
        return;
      }

      if (mod && /^[1-5]$/.test(event.key)) {
        const target = snapshots[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          openTool(target.href);
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange, snapshots]);

  const deepLinks = useMemo(
    () =>
      snapshots.flatMap((tool) =>
        tool.deepLinks
          .filter((link) => link.verified)
          .map((link) => ({ ...link, tool })),
      ),
    [snapshots],
  );

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search tools, pages and actions"
      shouldFilter
      className="fixed inset-0 z-50"
    >
      <div
        className="fixed inset-0 bg-overlay backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />

      <div className="fixed left-1/2 top-[15vh] w-[min(640px,calc(100vw-32px))] -translate-x-1/2">
        <div className="overflow-hidden rounded-xl border border-border bg-surface-elevated shadow-elevated">
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Command.Input
              autoFocus
              placeholder="Search tools, pages and actions…"
              className="h-13 w-full bg-transparent py-4 text-[15px] outline-none placeholder:text-muted-foreground"
            />
            <kbd className="shrink-0 rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-[10px] text-muted-foreground">
              esc
            </kbd>
          </div>

          <Command.List className="max-h-[420px] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              No matches.
            </Command.Empty>

            <Command.Group
              heading="Tools"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {snapshots.map((tool, index) => (
                <Command.Item
                  key={tool.id}
                  value={`${tool.name} ${tool.shortName} ${tool.description}`}
                  onSelect={() => {
                    openTool(tool.href);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-[14px]",
                    "data-[selected=true]:bg-selected-surface",
                  )}
                >
                  <ToolIcon id={tool.id} className="size-4 shrink-0 text-brand" />
                  <span className="flex-1 truncate">{tool.name}</span>
                  <StatusPip state={tool.state} />
                  <kbd className="shrink-0 rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    ⌘{index + 1}
                  </kbd>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group
              heading="Go to"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {deepLinks.map((link) => (
                <Command.Item
                  key={`${link.tool.id}:${link.id}`}
                  value={`${link.label} ${link.tool.name} ${(link.keywords ?? []).join(" ")}`}
                  onSelect={() => {
                    openTool(link.href);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[14px]",
                    "data-[selected=true]:bg-selected-surface",
                  )}
                >
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1 truncate">{link.label}</span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {link.tool.shortName}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group
              heading="Actions"
              className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              <Command.Item
                value="Refresh all statuses reload"
                onSelect={() => {
                  onRefresh();
                  onOpenChange(false);
                }}
                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[14px] data-[selected=true]:bg-selected-surface"
              >
                <RefreshCw className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                Refresh all statuses
              </Command.Item>
            </Command.Group>
          </Command.List>

          <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
            <span>↵ open in new tab</span>
            <span>↑↓ navigate</span>
            <span>esc close</span>
          </div>
        </div>
      </div>
    </Command.Dialog>
  );
}
