"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import { slugifyView } from "@/lib/tools/master-inbox/inbox/views-shared";

export function NewViewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Kept for backwards compatibility — labels are now selected inside the
  // FilterBuilder, not at view-creation time.
  labels?: LabelRow[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setName("");
    setError(null);
  }

  async function submit() {
    setError(null);
    setPending(true);
    const res = await fetch("/api/tools/master-inbox/custom-views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        filter_json: { preset: "all_email", rows: [] },
      }),
    });
    setPending(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Create failed");
      return;
    }
    const slug = slugifyView(name);
    reset();
    onOpenChange(false);
    // Navigate immediately — the destination loader reads the freshly
    // created view from Supabase, so it's already there by the time the
    // page renders. Skip the prior startTransition wrap, which made the
    // dialog close feel synchronous with the server-component refresh.
    router.push(`/inbox/${slug}`);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New view</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Hot Leads"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) submit();
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Empty tab to start. Use the <span className="font-medium">Filters</span> button on
            the new view to add label, channel, reply-since and other conditions, then click
            <span className="font-medium"> Save to {name.trim() || "view"}</span>.
          </p>
          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || pending}>
            Create view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
