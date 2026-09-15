"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import { Switch } from "@/components/mi-ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import type { LabelRow } from "@/lib/tools/master-inbox/inbox/labels-shared";
import {
  Btn,
  Chip,
  ConfirmButton,
  Field,
  Find,
  IconBtn,
  ToastHost,
  ToggleRow,
  useShowToast,
} from "./ui";

/*
 * Labels.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED AND WHAT DID NOT
 *
 * The markup is now the design's — `.tbl-wrap` + `.atbl` for the list, `.inp`
 * and `.sel` for the controls, the recessed `.mis-tog` group for the switches.
 * Every fetch, every optimistic update and every field is the code that was
 * already here.
 *
 * Two behaviour changes, both deliberate, both in SETTINGS-PARITY.md:
 *
 *   · delete was `window.confirm`, which suspends the page and therefore
 *     cannot be driven by any automated check. It is now the workspace's
 *     arm-then-fire button, and the sentence the native dialog carried moves
 *     to the button's title and its armed caption.
 *   · a failed delete was `alert()`. It is now the screen's own status line,
 *     which is both visible in the design and readable by a test.
 *
 * The colour picker previews the result as the chip the INBOX will actually
 * draw (`.lc-*`), rather than a Tailwind swatch that only approximates it.
 */

type Color = "green" | "red" | "amber" | "zinc" | "stone" | "pink" | "blue";
type Sentiment = "positive" | "negative" | "neutral";
type Platform = "email" | "both";

/* The same seven values the API accepts, ordered the way the design orders a
   palette: the three semantic tones, then blue, then the two neutrals. */
const COLOR_OPTIONS: Color[] = ["green", "red", "amber", "blue", "pink", "zinc", "stone"];

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

export function LabelsManager({ labels }: { labels: LabelRow[] }) {
  return (
    <ToastHost>
      <LabelsBody labels={labels} />
    </ToastHost>
  );
}

function LabelsBody({ labels: initial }: { labels: LabelRow[] }) {
  const router = useRouter();
  const show = useShowToast();
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
    const url = editing
      ? `/api/tools/master-inbox/labels/${editing.id}`
      : "/api/tools/master-inbox/labels";
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
    show({ text: editing ? `Saved “${form.name}”` : `Created “${form.name}”` });
    // Fire-and-forget background refresh — no startTransition wrapper,
    // no await. Local state is already correct.
    router.refresh();
  }

  async function handleDelete(l: LabelRow) {
    const previous = labels;
    // Optimistic remove first.
    setLabels((cur) => cur.filter((x) => x.id !== l.id));
    const res = await fetch(`/api/tools/master-inbox/labels/${l.id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      show({ text: json.error ?? "Delete failed", bad: true });
      setLabels(previous);
      return;
    }
    show({ text: `Deleted “${l.name}”` });
    router.refresh();
  }

  const visible = labels.filter((l) =>
    filter ? l.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  return (
    <>
      <div className="mis-bar">
        <Find
          value={filter}
          onChange={setFilter}
          label="Search labels"
          placeholder="Search labels"
          name="label_search"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        <span className="mis-count tnum">
          {visible.length} of {labels.length} label{labels.length === 1 ? "" : "s"}
        </span>
        <span className="mis-gap" />
        <Btn primary onClick={openCreate} data-mis="create-label">
          <Plus aria-hidden />
          Create label
        </Btn>
      </div>

      <div className="tbl-wrap mis-sec">
        <div className="tbl-scroll">
          <table className="atbl">
            <thead>
              <tr>
                <th>Label</th>
                <th>Sentiment</th>
                <th>Platform</th>
                <th>Obligation</th>
                <th>Source</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="mis-empty-cell">
                    No labels match.
                  </td>
                </tr>
              ) : (
                visible.map((l) => (
                  <tr key={l.id} data-mis-label={l.name}>
                    <td>
                      <Chip name={l.name} color={l.color} />
                    </td>
                    <td className="mut mis-cap">{l.sentiment}</td>
                    <td className="mut mis-cap">{l.platform}</td>
                    <td className="mut">{l.obligation ? "Yes" : "No"}</td>
                    <td className="mut">{l.is_system ? "System" : "Custom"}</td>
                    <td className="mis-cell-a">
                      <div>
                        <IconBtn label={`Edit ${l.name}`} onClick={() => openEdit(l)}>
                          <Pencil aria-hidden />
                        </IconBtn>
                        {/*
                          System labels seed every workspace and the API refuses
                          to delete them, so the control is ABSENT rather than
                          disabled — a greyed button invites a click to find out
                          why, which is the wrong way to learn a rule.
                        */}
                        {!l.is_system ? (
                          <ConfirmButton
                            compact
                            label="Delete"
                            armedLabel="Confirm delete"
                            title={`Delete label “${l.name}”? It comes off every conversation carrying it.`}
                            disabled={pending}
                            onConfirm={() => void handleDelete(l)}
                          >
                            <Trash2 aria-hidden />
                          </ConfirmButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit label" : "Create label"}</DialogTitle>
          </DialogHeader>

          <div className="mis-form">
            <Field label="Name">
              <input
                className="inp"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Interested"
                aria-label="Label name"
                autoFocus
              />
            </Field>

            <div className="mis-f">
              <span className="mis-l">Colour</span>
              <div className="mis-sw" role="group" aria-label="Label colour">
                {COLOR_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm({ ...form, color: c })}
                    className={`mis-c-${c}`}
                    aria-pressed={form.color === c}
                    aria-label={c}
                    title={c}
                  />
                ))}
              </div>
              <div className="mis-prev">
                Preview
                <Chip name={form.name || "Sample"} color={form.color} />
              </div>
            </div>

            <div className="mis-g mis-g2">
              <Field label="Sentiment">
                <select
                  className="sel"
                  aria-label="Sentiment"
                  value={form.sentiment}
                  onChange={(e) => setForm({ ...form, sentiment: e.target.value as Sentiment })}
                >
                  <option value="positive">Positive</option>
                  <option value="negative">Negative</option>
                  <option value="neutral">Neutral</option>
                </select>
              </Field>
              <Field label="Platform">
                <select
                  className="sel"
                  aria-label="Platform"
                  value={form.platform}
                  onChange={(e) => setForm({ ...form, platform: e.target.value as Platform })}
                >
                  <option value="both">Both</option>
                  <option value="email">Email only</option>
                </select>
              </Field>
            </div>

            <div>
              <ToggleRow title="Obligation" hint="Threads with this label appear in Needs Reply.">
                <Switch
                  checked={form.obligation}
                  aria-label="Obligation"
                  onCheckedChange={(v) => setForm({ ...form, obligation: v })}
                />
              </ToggleRow>
              <ToggleRow
                title="Mirror to EmailBison"
                hint="Sync this label as a tag on EmailBison replies."
              >
                <Switch
                  checked={form.mirror_to_emailbison}
                  aria-label="Mirror to EmailBison"
                  onCheckedChange={(v) => setForm({ ...form, mirror_to_emailbison: v })}
                />
              </ToggleRow>
            </div>

            {error ? (
              <p className="mis-err" role="alert">
                {error}
              </p>
            ) : null}
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
    </>
  );
}
