"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Mail,
  Folder,
  Tag,
  Trash2,
  Download,
  Plus,
  Check,
  ChevronDown,
  AlertTriangle,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/mi-ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { Button } from "@/components/mi-ui/button";
import { LabelChip } from "@/components/master-inbox/label-chip";
import { CreateListDialog } from "@/components/master-inbox/create-list-dialog";
import { cn } from "@/lib/tools/master-inbox/utils";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import type { ListRow } from "@/lib/tools/master-inbox/inbox/lists-shared";
import { MoveAgentMenu } from "@/components/master-inbox/move-agent-menu";

export function BulkActionsBar({
  selected,
  onClear,
  labels,
  lists,
  view,
}: {
  selected: string[];
  onClear: () => void;
  labels: LabelRow[];
  lists: ListRow[];
  // The current inbox view slug (open / archived / trash / spam / custom).
  // "Delete forever" is rendered only when view === "trash".
  view?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [createListOpen, setCreateListOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState("");
  // Permanent-delete confirmation modal. Snapshots the count + ids at
  // open time so a checkbox change while the dialog is up can't shift
  // what "Delete N" refers to.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmIds, setConfirmIds] = useState<string[]>([]);
  const [confirmPending, setConfirmPending] = useState(false);

  // Case-insensitive substring match — same pattern as the
  // thread-level label picker so both dropdowns feel the same.
  const visibleLabels = useMemo(() => {
    const q = labelFilter.trim().toLowerCase();
    if (!q) return labels;
    return labels.filter((l) => l.name.toLowerCase().includes(q));
  }, [labels, labelFilter]);

  async function bulk(body: object) {
    const res = await fetch("/api/tools/master-inbox/threads/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? "Action failed");
      return false;
    }
    return true;
  }

  async function doSeen(seen: boolean) {
    const ok = await bulk({ action: "seen", thread_ids: selected, seen });
    if (ok) startTransition(() => router.refresh());
  }

  async function doStatus(status: "open" | "archived" | "trash") {
    const ok = await bulk({ action: "status", thread_ids: selected, status });
    if (ok) {
      onClear();
      startTransition(() => router.refresh());
    }
  }

  async function doDelete() {
    if (!confirm(`Move ${selected.length} thread(s) to trash?`)) return;
    const ok = await bulk({ action: "delete", thread_ids: selected });
    if (ok) {
      onClear();
      startTransition(() => router.refresh());
    }
  }

  function openDeleteForever() {
    setConfirmIds(selected);
    setConfirmOpen(true);
  }

  async function confirmDeleteForever() {
    if (confirmIds.length === 0) return;
    setConfirmPending(true);
    const ok = await bulk({
      action: "delete_permanent",
      thread_ids: confirmIds,
    });
    setConfirmPending(false);
    if (ok) {
      setConfirmOpen(false);
      setConfirmIds([]);
      onClear();
      startTransition(() => router.refresh());
    }
  }

  async function doLabels(label_ids: string[], op: "add" | "remove") {
    const ok = await bulk({ action: "labels", thread_ids: selected, label_ids, op });
    if (ok) startTransition(() => router.refresh());
  }

  async function doList(list_id: string) {
    const ok = await bulk({ action: "list", thread_ids: selected, list_id, op: "add" });
    if (ok) {
      onClear();
      startTransition(() => router.refresh());
    }
  }

  async function doExport() {
    const res = await fetch("/api/tools/master-inbox/threads/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_ids: selected }),
    });
    if (!res.ok) {
      alert("Export failed");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `threads-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="flex items-center gap-1 ml-2">
        <span className="text-sm text-muted-foreground mr-2">
          {selected.length} selected
        </span>

        {/* Move agent — re-tag selected threads to a different client */}
        <MoveAgentMenu
          threadIds={selected}
          currentClientId={null}
          onMoved={() => {
            onClear();
            startTransition(() => router.refresh());
          }}
          disabled={pending}
        />

        {/* Move to list */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ToolbarButton
                icon={Folder}
                label="Move to list"
                disabled={pending}
                showChevron
              />
            }
          />
          <DropdownMenuContent align="end" className="w-56 max-h-72 overflow-y-auto">
            {lists.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2 py-2">
                No lists yet.
              </div>
            ) : (
              lists.map((l) => (
                <DropdownMenuItem
                  key={l.id}
                  onClick={() => doList(l.id)}
                  className="gap-2"
                >
                  <span className="text-base leading-none">{l.icon ?? "📁"}</span>
                  {l.name}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuItem
              onClick={() => setCreateListOpen(true)}
              className="gap-2 border-t mt-1 pt-2"
            >
              <Plus className="size-3.5" />
              Create new list
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Seen status */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ToolbarButton
                icon={Mail}
                label="Change seen status"
                disabled={pending}
                showChevron
              />
            }
          />
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => doSeen(true)}>Mark as seen</DropdownMenuItem>
            <DropdownMenuItem onClick={() => doSeen(false)}>Mark as unseen</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Folder */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ToolbarButton
                icon={Folder}
                label="Folder"
                disabled={pending}
                showChevron
              />
            }
          />
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => doStatus("open")}>Move to inbox</DropdownMenuItem>
            <DropdownMenuItem onClick={() => doStatus("archived")}>Move to archive</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Labels */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <ToolbarButton
                icon={Tag}
                label="Apply labels"
                disabled={pending}
                showChevron
              />
            }
          />
          <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-y-auto p-0">
            {labels.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2 py-2">
                No labels yet — create one in Settings → Labels.
              </div>
            ) : (
              <>
                <div className="sticky top-0 z-10 border-b bg-background p-1.5">
                  <input
                    type="search"
                    value={labelFilter}
                    onChange={(e) => setLabelFilter(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    placeholder="Search labels…"
                    autoFocus
                    className="h-7 w-full rounded-md border bg-background px-2 text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </div>
                <div className="p-1">
                  {visibleLabels.length === 0 ? (
                    <div className="text-xs text-muted-foreground px-2 py-2 text-center">
                      No labels match &quot;{labelFilter}&quot;.
                    </div>
                  ) : (
                    visibleLabels.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => doLabels([l.id], "add")}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1.5 text-left rounded hover:bg-accent text-sm",
                          pending && "opacity-50",
                        )}
                      >
                        <Check className="size-3.5 opacity-0" />
                        <LabelChip name={l.name} color={l.color} />
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Delete (soft delete → move to trash). Kept identical across
            every view, including the trash view itself (no-op there but
            harmless). Stephanie's constraint: permanent delete is its
            own button, only in trash, never the default action. */}
        <ToolbarButton
          icon={Trash2}
          label="Delete"
          onClick={doDelete}
          disabled={pending}
        />

        {/* Delete forever — only in the Trash view. Distinct icon, red
            tone, label always visible so it can't be mistaken for the
            soft-delete button above. */}
        {view === "trash" ? (
          <button
            type="button"
            onClick={openDeleteForever}
            disabled={pending || selected.length === 0}
            aria-label="Delete forever"
            className={cn(
              "h-8 px-2 inline-flex items-center gap-1 rounded-md text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors",
              (pending || selected.length === 0) && "opacity-50 cursor-not-allowed",
            )}
          >
            <AlertTriangle className="size-[15px]" strokeWidth={2} />
            <span className="text-[13px] font-medium">Delete forever</span>
          </button>
        ) : null}

        {/* Export */}
        <ToolbarButton
          icon={Download}
          label="Export CSV"
          onClick={doExport}
          disabled={pending}
          showLabel
        />

        <button
          type="button"
          onClick={onClear}
          className="ml-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>

      <CreateListDialog
        open={createListOpen}
        onOpenChange={setCreateListOpen}
        onCreated={(listId) => {
          doList(listId);
        }}
      />

      <Dialog
        open={confirmOpen}
        onOpenChange={(v) => {
          if (confirmPending) return;
          setConfirmOpen(v);
          if (!v) setConfirmIds([]);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {confirmIds.length}{" "}
              {confirmIds.length === 1 ? "thread" : "threads"} forever?
            </DialogTitle>
            <DialogDescription>
              This permanently removes the selected{" "}
              {confirmIds.length === 1 ? "thread" : "threads"} and all
              messages, drafts, and notes attached to{" "}
              {confirmIds.length === 1 ? "it" : "them"}. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={confirmPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDeleteForever}
              disabled={confirmPending || confirmIds.length === 0}
            >
              {confirmPending
                ? "Deleting…"
                : `Delete ${confirmIds.length}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  showChevron,
  showLabel,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  showChevron?: boolean;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "h-8 px-2 inline-flex items-center gap-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <Icon className="size-[15px]" strokeWidth={2} />
      {showLabel ? <span className="text-[13px]">{label}</span> : null}
      {showChevron ? <ChevronDown className="size-3" /> : null}
    </button>
  );
}
