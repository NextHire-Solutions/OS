"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import {
  Btn,
  ConfirmButton,
  Field,
  IconBtn,
  ToastHost,
  useShowToast,
} from "./ui";

/*
 * Clients.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED
 *
 * The list is now the design's `.tbl-wrap` with its own row rhythm, the aliases
 * are the design's chips, and the editor keeps the shared Dialog. Every fetch,
 * the optimistic create / update / delete, and the background re-sync that
 * corrects `thread_count` are the code that was already here.
 *
 * Two behaviour changes, both in SETTINGS-PARITY.md:
 *
 *   · delete was `window.confirm`. It is the arm-then-fire button now, and the
 *     consequence the native dialog spelled out — "threads tagged with it will
 *     be untagged, and re-tagged on the next webhook" — is on the button.
 *   · every message went to `sonner`, whose `<Toaster />` this app never
 *     mounts, so adding a client has been confirming nothing. They go to the
 *     workspace's own status line now.
 */

interface ClientRow {
  id: string;
  name: string;
  slug: string;
  aliases: string[];
  thread_count: number;
  is_system: boolean;
}

export function ClientsManager({ initial }: { initial: ClientRow[] }) {
  return (
    <ToastHost>
      <ClientsBody initial={initial} />
    </ToastHost>
  );
}

function ClientsBody({ initial }: { initial: ClientRow[] }) {
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

  const configured = rows.filter((r) => !r.is_system).length;

  return (
    <>
      <div className="mis-bar">
        <span className="mis-count tnum">
          {configured} client{configured === 1 ? "" : "s"} configured
        </span>
        <span className="mis-gap" />
        <Btn primary onClick={() => setAddOpen(true)} data-mis="add-client">
          <Plus aria-hidden />
          Add client
        </Btn>
      </div>

      <div className="anno new mis-sec" style={{ margin: 0 }}>
        <span>
          <b>Aliases catch variations in a campaign name.</b> Add{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>C21 Results Elite Team</code>{" "}
          as an alias for{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>C21 Results - Elite Team</code>{" "}
          and both campaigns tag to the same client.
        </span>
      </div>

      <div className="tbl-wrap mis-sec">
        <div className="mis-list">
          {rows.map((c) => (
            <ClientRowView
              key={c.id}
              row={c}
              onEdit={() => setEditing(c)}
              onDeleted={() => applyDelete(c.id)}
            />
          ))}
          {rows.length === 0 ? (
            <div className="mis-empty">
              <b>No clients yet</b>
              <p>Add one so inbound replies can be tagged against it.</p>
            </div>
          ) : null}
        </div>
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
    </>
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
  const show = useShowToast();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (row.is_system) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tools/master-inbox/clients/${row.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        show({ text: j.error ?? "Delete failed", bad: true });
        return;
      }
      show({ text: `Deleted ${row.name}` });
      onDeleted();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mis-row" data-mis-client={row.name}>
      <div className="mis-row-m">
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span className="mis-row-n">{row.name}</span>
          {row.is_system ? (
            <span className="plan plan-min" title="Replies that match no client land here.">
              fallback
            </span>
          ) : null}
          <span className="mis-count tnum" style={{ marginLeft: "auto" }}>
            {row.thread_count} thread{row.thread_count === 1 ? "" : "s"}
          </span>
        </div>
        {row.aliases.length > 0 ? (
          <div className="mis-tags" style={{ marginTop: 9 }}>
            {row.aliases.map((a) => (
              <span key={a} className="mis-tag mis-tag-q">
                {a}
              </span>
            ))}
          </div>
        ) : (
          <div className="mis-row-s">No aliases.</div>
        )}
      </div>
      <div className="mis-row-a">
        <IconBtn
          label={`Edit ${row.name}`}
          onClick={onEdit}
          disabled={row.is_system}
          title={
            row.is_system
              ? "The fallback client is created by the system and cannot be edited."
              : `Edit ${row.name}`
          }
        >
          <Pencil aria-hidden />
        </IconBtn>
        {row.is_system ? (
          <IconBtn
            label={`Delete ${row.name}`}
            danger
            disabled
            title="The fallback client is created by the system and cannot be deleted."
          >
            <Trash2 aria-hidden />
          </IconBtn>
        ) : (
          <ConfirmButton
            compact
            label="Delete"
            armedLabel="Confirm delete"
            title={`Delete client “${row.name}”? Threads tagged with it are untagged, and re-tagged on the next webhook.`}
            disabled={deleting}
            onConfirm={() => void handleDelete()}
          >
            <Trash2 aria-hidden />
          </ConfirmButton>
        )}
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
  const show = useShowToast();
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
      show({ text: "Name is required", bad: true });
      return;
    }
    setSaving(true);
    try {
      const url =
        mode === "create"
          ? "/api/tools/master-inbox/clients"
          : `/api/tools/master-inbox/clients/${initial!.id}`;
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
        show({ text: j.error ?? "Save failed", bad: true });
        return;
      }
      show({ text: mode === "create" ? `Added ${name.trim()}` : `Updated ${name.trim()}` });
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Add client" : `Edit ${initial?.name}`}</DialogTitle>
          <DialogDescription>
            Threads whose campaign name contains the client name (or any alias) get auto-tagged.
            Longest match wins.
          </DialogDescription>
        </DialogHeader>

        <div className="mis-form">
          <Field label="Name" htmlFor="client-name">
            <input
              id="client-name"
              className="inp"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Brooklyn Group"
              autoFocus
            />
          </Field>

          <div className="mis-f">
            <label className="mis-l" htmlFor="client-alias">
              Aliases <span className="mis-opt">(optional)</span>
            </label>
            <div className="mis-inline">
              <input
                id="client-alias"
                className="inp"
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
              <Btn onClick={addAlias} disabled={!draft.trim()}>
                Add
              </Btn>
            </div>
            {aliases.length > 0 ? (
              <div className="mis-tags" style={{ marginTop: 10 }}>
                {aliases.map((a) => (
                  <span key={a} className="mis-tag">
                    {a}
                    <button
                      type="button"
                      onClick={() => setAliases(aliases.filter((x) => x !== a))}
                      aria-label={`Remove ${a}`}
                    >
                      <X aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mis-hint">
                No aliases yet. Add common variations of the campaign name to broaden matching.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()} data-mis="save-client">
            {saving ? "Saving…" : mode === "create" ? "Add client" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
