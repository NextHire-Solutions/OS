"use client";

import { Pencil, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/mi-ui/sheet";
import { Button } from "@/components/mi-ui/button";
import { Avatar } from "@/components/master-inbox/portals-ui/portal-ui";
import { PipelineDetailInline } from "@/components/master-inbox/portals-ui/pipeline-detail-inline";
import { SourceBadge } from "@/components/master-inbox/portals-ui/source-badge";
import type { PipelineEntry } from "@/lib/tools/master-inbox/portals/stages-shared";

// Right-side drawer showing the FULL lead detail view (custom
// variables, brokerage, profile, intro date, notes) for a Kanban
// card click. Mirrors ConversationSheet's structure for visual
// consistency with the other portal sheet.
//
// Why a sheet (and not the inline-expand the list view uses):
// Kanban columns are too narrow to host an in-place expansion;
// a right-side drawer keeps the board visible while details are
// open and matches the conversation-sheet pattern operators have
// seen elsewhere.
//
// The body is just <PipelineDetailInline>, which is already used
// for the list-view expand drawer — single source of truth for
// the rendered field list. The header surfaces the lead name +
// an "Edit details" affordance that closes the sheet and hands
// off to EditLeadDialog (parity with the per-row pencil button
// in the table).

export function PipelineDetailSheet({
  entry,
  token,
  onClose,
  onEdit,
  onLocalUpdate,
  showSource = false,
}: {
  entry: PipelineEntry;
  token: string;
  onClose: () => void;
  // Called when the user clicks "Edit details" in the sheet
  // header. The parent typically closes the sheet and opens
  // EditLeadDialog for the same entry.
  onEdit: () => void;
  onLocalUpdate?: (patch: Partial<PipelineEntry>) => void;
  showSource?: boolean;
}) {
  return (
    <Sheet open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-white p-0 sm:max-w-[720px]"
        // Offset the sheet below the Calendly banner. Portal pages
        // set `--portal-banner-h` on <html> (2.5rem when the banner
        // is visible, 0 otherwise) — see calendly-banner.tsx + the
        // shell layout. Without this the sheet's `inset-y-0`
        // anchors it to the very top of the viewport and the
        // banner clips the header.
        style={{
          top: "var(--portal-banner-h, 0px)",
          height: "calc(100vh - var(--portal-banner-h, 0px))",
        }}
        showCloseButton={false}
      >
        <header className="relative shrink-0 border-b border-[#ebecf0] bg-white px-6 pt-5 pb-5">
          <div className="flex items-start gap-2">
            <Avatar
              name={entry.lead_name ?? entry.lead_email ?? "?"}
              className="size-11 shrink-0 text-[14px]"
            />
            <div className="min-w-0 flex-1">
              <h2 className="break-words pr-2 text-[17px] font-semibold leading-tight text-[#0f1320]">
                {entry.lead_name || entry.lead_email || "Unknown"}
              </h2>
              {showSource && entry.source ? (
                <div className="mt-1.5">
                  <SourceBadge value={entry.source} />
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={onEdit}
                className="h-8"
              >
                <Pencil className="mr-1 size-3.5" />
                Edit
              </Button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="inline-flex size-8 items-center justify-center rounded-md border border-[#ebecf0] bg-white text-[#5b6472] hover:bg-[#f6f7f9]"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto bg-[#fafbfc]">
          {/* compact = narrow-container layout: 2-col grid, no
              truncation on link values. Without it the
              inline-list-view 4-col grid renders here and squishes
              every value to "tom…" / "corc…" inside this 560-px
              sheet. */}
          <PipelineDetailInline
            entry={entry}
            token={token}
            onLocalUpdate={onLocalUpdate}
            showSource={showSource}
            compact
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
