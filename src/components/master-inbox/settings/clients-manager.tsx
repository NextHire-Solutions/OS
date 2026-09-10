"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, X, Pencil, Trash2, Check } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import { Label } from "@/components/mi-ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";

interface ClientRow {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  thread_count: number;
  is_system: boolean;
}

export function ClientsManager({ initial }: { initial: ClientRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<ClientRow[]>(initial);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ClientRow | null>(null);

  // Fire-and-forget background sync. We update local rows
  // optimistically in the handlers below, then this fills in any
  // fields the optimistic path couldn't predict (thread_count, etc).
  // Detached from the user's mutation so the UI never waits on it.
  function backgroundResync() {
    fetch("/api/tools/master-inbox/clients", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setRows(j.clients);
      })
      .catch(() => {
        /* sync failures don't matter — page refresh below catches them */
      });
    router.refresh();
  }

  function applyCreate(row: ClientRow) {
    setRows((cur) => [...cur, row].sort((a, b) => a.name.localeCompare(b.name)));
    backgroundResync();
  }
  function applyUpdate(row: ClientRow) {
    setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, ...row } : r)));
    backgroundResync();
  }
  function applyDelete(id: string) {
    setRows((cur) => cur.filter((r) => r.id !== id));
    backgroundResync();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {rows.filter((r) => !r.is_system).length} client
          {rows.filter((r) => !r.is_system).length === 1 ? "" : "s"} configured.
          Add aliases to catch variations in campaign names
          (e.g. <code className="text-xs">C21 Results Elite Team</code> as an alias
          for <code className="text-xs">C21 Results - Elite Team</code>).
        </p>
        <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
          <Plus className="size-4" /> Add client
        </Button>
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {rows.map((c) => (
          <ClientRowView
            key={c.id}
            row={c}
            onEdit={() => setEditing(c)}
            onDeleted={() => applyDelete(c.id)}
          />
        ))}
      </div>

      {addOpen ? (
        <ClientFormDialog
          mode="create"
          onClose={() => setAddOpen(false)}
          onSaved={(row) => {
            applyCreate(row);
            setAddOpen(false);
          }}
        />
      ) : null}

      {editing ? (
        <ClientFormDialog
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            applyUpdate(row);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ClientRowView({
  row,
  onEdit,
  onDeleted,
}: {
  row: ClientRow;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (row.is_system) return;
    if (!confirm(`Delete client "${row.name}"? Threads tagged with it will be untagged (and re-tagged on next webhook).`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tools/master-inbox/clients/${row.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(j.error ?? "Delete failed");
        return;
      }
      toast.success(`Deleted ${row.name}`);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-accent/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{row.name}</span>
          {row.is_system ? (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground border rounded px-1.5 py-0.5">
              fallback
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground ml-auto tabular-nums">
            {row.thread_count} thread{row.thread_count === 1 ? "" : "s"}
          </span>
        </div>
        {row.aliases.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {row.aliases.map((a) => (
              <span
                key={a}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] border bg-sky-50 text-sky-700 border-sky-200"
              >
                {a}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">No aliases.</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          disabled={row.is_system}
          className="h-7 px-2"
          aria-label="Edit"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          disabled={deleting || row.is_system}
          className="h-7 px-2 text-muted-foreground hover:text-red-600"
          aria-label="Delete"
        >
          {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function ClientFormDialog({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: ClientRow;
  onClose: () => void;
  // Caller updates local rows from this payload so the row appears /
  // updates instantly without waiting for /api/clients to re-list.
  onSaved: (row: ClientRow) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [aliases, setAliases] = useState<string[]>(initial?.aliases ?? []);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  function addAlias() {
    const v = draft.trim();
    if (!v) return;
    if (aliases.some((a) => a.toLowerCase() === v.toLowerCase())) {
      setDraft("");
      return;
    }
    setAliases([...aliases, v]);
    setDraft("");
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      const url = mode === "create" ? "/api/tools/master-inbox/clients" : `/api/tools/master-inbox/clients/${initial!.id}`;
      const res = await fetch(url, {
        method: mode === "create" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), aliases }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        client?: { id: string; name: string; slug: string; aliases: string[] };
      };
      if (!res.ok) {
        toast.error(j.error ?? "Save failed");
        return;
      }
      toast.success(mode === "create" ? `Added ${name}` : `Updated ${name}`);
      // Caller wants a ClientRow; thread_count and is_system aren't
      // returned by the create/update endpoints so we fill them in
      // optimistically. backgroundResync() corrects thread_count
      // shortly after.
      const saved = j.client;
      const row: ClientRow = {
        id: saved?.id ?? initial?.id ?? "",
        name: saved?.name ?? name.trim(),
        slug: saved?.slug ?? initial?.slug ?? "",
        aliases: saved?.aliases ?? aliases,
        thread_count: initial?.thread_count ?? 0,
        is_system: initial?.is_system ?? false,
      };
      onSaved(row);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add client" : `Edit ${initial?.name}`}</DialogTitle>
          <DialogDescription>
            Threads whose campaign name contains the client name (or any alias)
            get auto-tagged. Longest match wins.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="client-name">Name</Label>
            <Input
              id="client-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Brooklyn Group"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="client-alias">Aliases (optional)</Label>
            <div className="flex gap-2">
              <Input
                id="client-alias"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAlias();
                  }
                }}
                placeholder="e.g. C21 Results Elite Team"
              />
              <Button type="button" variant="outline" onClick={addAlias} disabled={!draft.trim()}>
                Add
              </Button>
            </div>
            {aliases.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {aliases.map((a) => (
                  <span
                    key={a}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border bg-sky-50 text-sky-700 border-sky-200"
                  >
                    {a}
                    <button
                      type="button"
                      onClick={() => setAliases(aliases.filter((x) => x !== a))}
                      className="hover:text-sky-900"
                      aria-label={`Remove ${a}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No aliases yet. Add common variations of the campaign name to broaden matching.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()} className="gap-1.5">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {mode === "create" ? "Add client" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
