"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ListRow } from "@/lib/tools/master-inbox/inbox/lists-shared";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { cn } from "@/lib/tools/master-inbox/utils";

// Lightweight emoji picker. Categories match the masterinbox UI; we
// hard-code a useful subset rather than pulling in a full emoji library.
// No search bar — the grid is small enough to scan visually.
const CATEGORIES: { name: string; items: string[] }[] = [
  {
    name: "Smileys & emotion",
    items: [
      "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","☺️","😚","😙","🥲","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐",
    ],
  },
  {
    name: "Objects & symbols",
    items: ["🚀","⭐","✨","🔥","💎","🎯","🏆","🎉","💼","📁","📂","📌","📍","🔖","🏷️","📊","📈","📉","💰","💵","🤝","🧠","💡","⚡","🔔","📣","🛎️","🛒","🎁","✅","❌","➕","➖","🔒","🔓","🔑"],
  },
  {
    name: "Activities & travel",
    items: ["✈️","🚗","🏢","🏠","🏬","🌍","🌎","🌏","🗺️","🏝️","⛰️","🎪","🎨","🎭","📷","🎵","🎮","🏀","⚽","🏈","🎾","🏐"],
  },
  {
    name: "Animals & nature",
    items: ["🐶","🐱","🦊","🦁","🐯","🐮","🐷","🐸","🐵","🦄","🦋","🌸","🌹","🌳","🌲","🌴","🍀","🌾","☀️","🌙","⭐","🌈","☁️","❄️"],
  },
];

export function CreateListDialog({
  open,
  onOpenChange,
  onCreated,
  // When set, the dialog is in edit mode: title says "Update", initial
  // values come from this list, submit PATCHes /api/lists/{id} instead
  // of POSTing a new row.
  editing = null,
  onUpdated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (id: string) => void;
  editing?: ListRow | null;
  onUpdated?: () => void;
}) {
  const router = useRouter();
  const isEdit = editing !== null;
  const [name, setName] = useState(editing?.name ?? "");
  const [icon, setIcon] = useState(editing?.icon ?? "🚀");
  const [iconOpen, setIconOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset form whenever we switch into editing a different list (or open
  // the create dialog after a previous edit closed).
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setIcon(editing?.icon ?? "🚀");
    setIconOpen(false);
    setError(null);
  }, [open, editing?.id, editing?.name, editing?.icon, editing]);

  async function submit() {
    setError(null);
    if (isEdit && editing) {
      const patch: Record<string, string | null> = {};
      if (name.trim() !== editing.name) patch.name = name.trim();
      if ((editing.icon ?? "") !== icon) patch.icon = icon;
      if (Object.keys(patch).length === 0) {
        onOpenChange(false);
        return;
      }
      const res = await fetch(`/api/tools/master-inbox/lists/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Update failed");
        return;
      }
      onOpenChange(false);
      onUpdated?.();
      startTransition(() => router.refresh());
      return;
    }
    const res = await fetch("/api/tools/master-inbox/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), icon }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Create failed");
      return;
    }
    const data = await res.json();
    setName("");
    setIcon("🚀");
    onOpenChange(false);
    onCreated?.(data.id);
    startTransition(() => router.refresh());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Update list item" : "Create list item"}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[auto_1fr] gap-4 items-start">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Add icon</label>
            <button
              type="button"
              onClick={() => setIconOpen((v) => !v)}
              className="size-16 rounded-md border bg-background flex items-center justify-center text-3xl hover:bg-accent transition-colors"
              aria-label="Pick icon"
            >
              {icon}
            </button>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              List name<span className="text-red-500 ml-0.5">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Eg. Customers"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) submit();
              }}
            />
          </div>
        </div>

        {iconOpen ? (
          <div className="rounded-md border bg-card max-h-72 overflow-y-auto">
            <div className="p-3 space-y-3">
              {CATEGORIES.map((c) => (
                <div key={c.name}>
                  <p className="text-xs text-muted-foreground mb-1.5">{c.name}</p>
                  <div className="grid grid-cols-10 gap-1">
                    {c.items.map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() => {
                          setIcon(e);
                          setIconOpen(false);
                        }}
                        className={cn(
                          "size-7 rounded flex items-center justify-center text-lg hover:bg-accent transition-colors",
                          icon === e && "bg-accent ring-1 ring-foreground",
                        )}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error ? <p className="text-xs text-red-600">{error}</p> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || pending}>
            {isEdit ? "Update" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
