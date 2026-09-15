"use client";

import { useState, useTransition } from "react";
import type { ListRow } from "@/lib/tools/master-inbox/inbox/lists-shared";
import { Button } from "@/components/mi-ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";

// DELETE /api/lists/{id}. Hard delete — thread_list_items cascades via
// the FK; threads keep their client_id intact (the list was just a view).
//
// Ported from the tool's `components/layout/sidebar.tsx`, where it was a
// private function beside the sidebar's list rows. Here the rows live in the
// client-lists rail, so it is its own file.
export function DeleteListDialog({
  list,
  onClose,
  onDeleted,
}: {
  list: ListRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  // The tool reported a failed delete through `sonner`'s `toast.error`. No
  // `<Toaster />` is mounted in this app, so that message would go nowhere;
  // it is shown inside the dialog instead, the way the sibling
  // CreateListDialog already reports its own failures.
  const [error, setError] = useState<string | null>(null);
  if (!list) return null;
  async function confirmDelete() {
    if (!list) return;
    setError(null);
    const res = await fetch(`/api/tools/master-inbox/lists/${list.id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Delete failed");
      return;
    }
    startTransition(() => onDeleted());
  }
  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete &quot;{list.name}&quot;?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The list will be removed from the sidebar. Threads themselves stay
          intact — you can recreate the list later if you change your mind.
        </p>
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={confirmDelete}
            disabled={pending}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
