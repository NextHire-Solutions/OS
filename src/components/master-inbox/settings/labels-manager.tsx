"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Search } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Input } from "@/components/mi-ui/input";
import { Switch } from "@/components/mi-ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import { LabelChip } from "@/components/master-inbox/label-chip";
import { cn } from "@/lib/tools/master-inbox/utils";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";

type Color = "green" | "red" | "amber" | "zinc" | "stone" | "pink" | "blue";
type Sentiment = "positive" | "negative" | "neutral";
type Platform = "email" | "both";

const COLOR_OPTIONS: { value: Color; swatch: string }[] = [
  { value: "green", swatch: "bg-emerald-400" },
  { value: "red", swatch: "bg-red-400" },
  { value: "amber", swatch: "bg-amber-400" },
  { value: "blue", swatch: "bg-blue-400" },
  { value: "pink", swatch: "bg-pink-400" },
  { value: "zinc", swatch: "bg-zinc-400" },
  { value: "stone", swatch: "bg-stone-400" },
];

interface FormState {
  name: string;
  color: Color;
  sentiment: Sentiment;
  platform: Platform;
  obligation: boolean;
  mirror_to_emailbison: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  color: "zinc",
  sentiment: "neutral",
  platform: "both",
  obligation: false,
  mirror_to_emailbison: false,
};

export function LabelsManager({ labels: initial }: { labels: LabelRow[] }) {
  const router = useRouter();
  // Mirror the server-rendered list into local state so create / edit /
  // delete mutations can update the UI optimistically without waiting
  // for the next router refresh round-trip. The server is still the
  // source of truth — we re-sync from the `labels` prop whenever the
  // page re-renders (e.g. after the background refresh completes).
  const [labels, setLabels] = useState<LabelRow[]>(initial);
  useEffect(() => setLabels(initial), [initial]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LabelRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  // `pending` flips while a network call is in flight so we can dim the
  // dialog buttons. We dropped the previous startTransition wrapping
  // (it was making the close feel synchronous with router.refresh())
  // but kept the local flag so the UI still indicates work in progress.
  const [pending, setPending] = useState(false);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
    setOpen(true);
  }

  function openEdit(l: LabelRow) {
    setEditing(l);
    setForm({
      name: l.name,
      color: (l.color as Color) ?? "zinc",
      sentiment: l.sentiment,
      platform: l.platform,
      obligation: l.obligation,
      mirror_to_emailbison: l.mirror_to_emailbison,
    });
    setError(null);
    setOpen(true);
  }

  async function handleSubmit() {
    setError(null);
    setPending(true);
    const url = editing ? `/api/tools/master-inbox/labels/${editing.id}` : "/api/tools/master-inbox/labels";
    const method = editing ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setPending(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      setError(json.error ?? "Save failed");
      return;
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    // Optimistic local update — close the dialog immediately rather
    // than blocking on a router.refresh() round-trip. The background
    // refresh below will reconcile with the server later, but the
    // user sees their change land instantly.
    if (editing) {
      setLabels((cur) =>
        cur.map((l) =>
          l.id === editing.id
            ? {
                ...l,
                name: form.name,
                color: form.color,
                sentiment: form.sentiment,
                platform: form.platform,
                obligation: form.obligation,
                mirror_to_emailbison: form.mirror_to_emailbison,
              }
            : l,
        ),
      );
    } else if (json.id) {
      // POST returns just { id } today — construct the rest of the
      // row from the form so we can drop it straight into local
      // state without a follow-up GET.
      const newLabel: LabelRow = {
        id: json.id,
        name: form.name,
        color: form.color,
        sentiment: form.sentiment,
        platform: form.platform,
        obligation: form.obligation,
        mirror_to_emailbison: form.mirror_to_emailbison,
        sort_order: labels.length,
        is_system: false,
      };
      setLabels((cur) => [...cur, newLabel]);
    }
    setOpen(false);
    // Fire-and-forget background refresh — no startTransition wrapper,
    // no await. Local state is already correct.
    router.refresh();
  }

  async function handleDelete(l: LabelRow) {
    if (!confirm(`Delete label "${l.name}"?`)) return;
    const previous = labels;
    // Optimistic remove first.
    setLabels((cur) => cur.filter((x) => x.id !== l.id));
    const res = await fetch(`/api/tools/master-inbox/labels/${l.id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? "Delete failed");
      setLabels(previous);
      return;
    }
    router.refresh();
  }

  const visible = labels.filter((l) =>
    filter ? l.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search labels"
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="size-3.5" />
          Create Label
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2">Label</th>
              <th className="text-left font-medium px-4 py-2">Sentiment</th>
              <th className="text-left font-medium px-4 py-2">Platform</th>
              <th className="text-left font-medium px-4 py-2">Obligation</th>
              <th className="text-left font-medium px-4 py-2">Source</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">
                  No labels match.
                </td>
              </tr>
            ) : (
              visible.map((l) => (
                <tr key={l.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2">
                    <LabelChip name={l.name} color={l.color} />
                  </td>
                  <td className="px-4 py-2 capitalize text-muted-foreground">{l.sentiment}</td>
                  <td className="px-4 py-2 capitalize text-muted-foreground">{l.platform}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {l.obligation ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {l.is_system ? "System" : "Custom"}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-0.5 justify-end">
                      <button
                        type="button"
                        onClick={() => openEdit(l)}
                        className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                        aria-label="Edit"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      {!l.is_system ? (
                        <button
                          type="button"
                          onClick={() => handleDelete(l)}
                          disabled={pending}
                          className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-red-600 transition-colors"
                          aria-label="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit label" : "Create label"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">Name</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Interested"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Color</label>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_OPTIONS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setForm({ ...form, color: c.value })}
                    className={cn(
                      "size-7 rounded-full border-2 transition-all",
                      c.swatch,
                      form.color === c.value
                        ? "border-foreground scale-110"
                        : "border-transparent hover:border-muted-foreground/40",
                    )}
                    aria-label={c.value}
                  />
                ))}
              </div>
              <div className="pt-2">
                <span className="text-xs text-muted-foreground mr-2">Preview:</span>
                <LabelChip name={form.name || "Sample"} color={form.color} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Sentiment</label>
                <select
                  value={form.sentiment}
                  onChange={(e) =>
                    setForm({ ...form, sentiment: e.target.value as Sentiment })
                  }
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="positive">Positive</option>
                  <option value="negative">Negative</option>
                  <option value="neutral">Neutral</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Platform</label>
                <select
                  value={form.platform}
                  onChange={(e) =>
                    setForm({ ...form, platform: e.target.value as Platform })
                  }
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="both">Both</option>
                  <option value="email">Email only</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-xs font-medium">Obligation</p>
                <p className="text-[11px] text-muted-foreground">
                  Threads with this label appear in Needs Reply.
                </p>
              </div>
              <Switch
                checked={form.obligation}
                onCheckedChange={(v) => setForm({ ...form, obligation: v })}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div>
                <p className="text-xs font-medium">Mirror to EmailBison</p>
                <p className="text-[11px] text-muted-foreground">
                  Sync this label as a tag on EmailBison replies.
                </p>
              </div>
              <Switch
                checked={form.mirror_to_emailbison}
                onCheckedChange={(v) => setForm({ ...form, mirror_to_emailbison: v })}
              />
            </div>

            {error ? <p className="text-xs text-red-600">{error}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!form.name.trim() || pending}>
              {editing ? "Save changes" : "Create label"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
