"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, ChevronRight } from "lucide-react";
import { Button } from "@/components/mi-ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/mi-ui/dialog";
import dynamic from "next/dynamic";
import { Btn, Field, Find, IconBtn, ToastHost, useShowToast } from "./ui";

/*
 * Templates.
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED
 *
 * The panel is now a page of the design's cards: one `.tbl-wrap` per category,
 * each with the design's own collapsing header, and rows in the same 14px /
 * 20px rhythm as a `td`. The editor dialog keeps the shared Dialog primitive —
 * it renders through a portal alongside every other popup in the inbox, and
 * `mi-skin.css` already gives that portal the design's card.
 *
 * Every field, the datalist of existing categories, the rich editor with its
 * variables and its link dialog, the dual HTML + plain-text output, and the
 * delete confirmation are all the code that was already here.
 *
 * ---------------------------------------------------------------------------
 * ONE BEHAVIOUR FIX
 *
 * Save and delete reported through `sonner`'s `toast`. `<Toaster />` is not
 * mounted anywhere in this app — so for as long as this panel has been in the
 * workspace, saving a template has confirmed NOTHING and failing to save has
 * warned NOBODY. Both now go through the workspace's own status line.
 */

/*
 * Same reasoning as the composer's editor — see composer.tsx. This one is
 * needed only once someone opens a template to edit it, which is rarer still.
 */
const TemplateRichEditor = dynamic(
  () =>
    import("@/components/master-inbox/settings/template-rich-editor").then(
      (m) => m.TemplateRichEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="mis-ed" aria-busy="true">
        <div className="mis-ed-load">Loading editor…</div>
      </div>
    ),
  },
);

export interface TemplateRow {
  id: string;
  name: string;
  body: string;
  body_html: string | null;
  subject: string | null;
  cc: string | null;
  bcc: string | null;
  category: string | null;
}

const UNCATEGORISED = "Uncategorised";

// Bucket templates by category — named categories alphabetically,
// "Uncategorised" always last.
/*
 * Plain text → the HTML a rich editor round-trips without losing shape.
 *
 * Blank lines become separate paragraphs, single newlines become <br>, and the
 * text is escaped first so a template containing "<" or "&" cannot inject
 * markup into the editor. Template variables like {{lead.name}} pass through
 * untouched — they are not HTML and must survive verbatim.
 */
function plainTextToHtml(text: string): string {
  if (!text.trim()) return "";
  const escape = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escape(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function groupByCategory(
  rows: TemplateRow[],
): Array<{ category: string; templates: TemplateRow[] }> {
  const map = new Map<string, TemplateRow[]>();
  for (const t of rows) {
    const cat = (t.category ?? "").trim() || UNCATEGORISED;
    const list = map.get(cat) ?? [];
    list.push(t);
    map.set(cat, list);
  }
  return [...map.entries()]
    .map(([category, templates]) => ({ category, templates }))
    .sort((a, b) => {
      if (a.category === UNCATEGORISED) return 1;
      if (b.category === UNCATEGORISED) return -1;
      return a.category.localeCompare(b.category);
    });
}

export function TemplatesManager({ initial }: { initial: TemplateRow[] }) {
  return (
    <ToastHost>
      <TemplatesBody initial={initial} />
    </ToastHost>
  );
}

function TemplatesBody({ initial }: { initial: TemplateRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<TemplateRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<TemplateRow | null>(null);
  const [search, setSearch] = useState("");

  // Filter by search term across name, body, subject, category — case
  // insensitive.
  const filtered = useMemo(() => {
    if (!search.trim()) return initial;
    const q = search.trim().toLowerCase();
    return initial.filter((t) =>
      [t.name, t.body, t.subject, t.category]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q)),
    );
  }, [initial, search]);

  const groups = useMemo(() => groupByCategory(filtered), [filtered]);
  // Distinct existing category names — fed to the dialog's datalist.
  const categories = useMemo(
    () =>
      Array.from(
        new Set(
          initial.map((t) => (t.category ?? "").trim()).filter((c) => c.length > 0),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [initial],
  );

  return (
    <>
      <div className="mis-bar">
        <Find
          value={search}
          onChange={setSearch}
          label="Search templates"
          placeholder="Search templates…"
          name="template_search"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        <span className="mis-count tnum">
          {filtered.length} of {initial.length} template{initial.length === 1 ? "" : "s"}
        </span>
        <span className="mis-gap" />
        <Btn primary onClick={() => setEditing("new")} data-mis="new-template">
          <Plus aria-hidden />
          New template
        </Btn>
      </div>

      {initial.length === 0 ? (
        <div className="mis-sec card">
          <div className="mis-empty">
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6M9 13h6M9 17h4" />
            </svg>
            <b>No templates yet</b>
            <p>
              Create your first reusable reply snippet — group them into categories to stay
              organised.
            </p>
            <Btn primary onClick={() => setEditing("new")}>
              New template
            </Btn>
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="mis-sec card">
          <div className="mis-empty">
            <b>No templates match &ldquo;{search}&rdquo;.</b>
            <p>Try a shorter term — the search reads the name, the body, the subject and the
              category.</p>
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <CategorySection
            key={g.category}
            category={g.category}
            templates={g.templates}
            onEdit={setEditing}
            onDelete={setDeleting}
          />
        ))
      )}

      {editing ? (
        <EditDialog
          template={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          template={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

function CategorySection({
  category,
  templates,
  onEdit,
  onDelete,
}: {
  category: string;
  templates: TemplateRow[];
  onEdit: (t: TemplateRow) => void;
  onDelete: (t: TemplateRow) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="tbl-wrap mis-sec">
      <button
        type="button"
        className="mis-cat"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {/* One chevron that rotates, rather than two icons that swap — the
            rotation is the design's own accordion affordance (`.chev`). */}
        <ChevronRight className="mis-chev" aria-hidden />
        <b>{category}</b>
        <span className="mis-n tnum">{templates.length}</span>
      </button>
      {open ? (
        <div className="mis-list mis-cat-b">
          {templates.map((t) => (
            <div key={t.id} className="mis-row" data-mis-template={t.name}>
              <div className="mis-row-m">
                <div className="mis-row-n">{t.name}</div>
                {t.subject ? (
                  <div className="mis-row-s">
                    Subject: <b style={{ color: "var(--ink-2)", fontWeight: 600 }}>{t.subject}</b>
                  </div>
                ) : null}
                <div className="mis-row-s mis-clamp">{t.body || "(empty)"}</div>
                {t.cc || t.bcc ? (
                  <div className="mis-row-s" style={{ display: "flex", gap: 14 }}>
                    {t.cc ? <span>CC: {t.cc}</span> : null}
                    {t.bcc ? <span>BCC: {t.bcc}</span> : null}
                  </div>
                ) : null}
              </div>
              <div className="mis-row-a">
                <IconBtn label={`Edit ${t.name}`} onClick={() => onEdit(t)}>
                  <Pencil aria-hidden />
                </IconBtn>
                {/*
                  Unlike the other panels this delete keeps its own DIALOG
                  rather than becoming an arm-then-fire button: it is not a
                  `window.confirm`, it is a real dialog the tool wrote, it
                  names the template and explains the blast radius, and a test
                  can drive it. Changing it would remove a warning, not a
                  native-modal problem.
                */}
                <IconBtn label={`Delete ${t.name}`} danger onClick={() => onDelete(t)}>
                  <Trash2 aria-hidden />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EditDialog({
  template,
  categories,
  onClose,
  onSaved,
}: {
  template: TemplateRow | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const show = useShowToast();
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [cc, setCc] = useState(template?.cc ?? "");
  const [bcc, setBcc] = useState(template?.bcc ?? "");
  // Body is stored as both rich HTML (for the composer / future inbound
  // mail clients that respect it) and plain text (legacy `body` column,
  // also used as a fallback for variable substitution).
  /*
   * Falling back to the plain `body` means converting it, not handing it over.
   *
   * Two things were wrong here. `??` only falls back on null/undefined, so a
   * body_html of "" was used as-is and opened an empty editor. And when it did
   * fall back, it passed PLAIN TEXT into a rich-text editor — HTML collapses
   * newlines, so a template stored as "Hey {{lead.name}},\n\nI'd like to…"
   * opened as one run-on paragraph. Press Save on that and the paragraph breaks
   * are written back flattened: the formatting is destroyed by having looked at
   * it. One of the 44 templates is in this state today (body_html empty, body
   * full of newlines), so this is a live data-loss path, not a hypothetical.
   */
  const initialHtml = template?.body_html?.trim()
    ? template.body_html
    : plainTextToHtml(template?.body ?? "");
  const [bodyHtml, setBodyHtml] = useState(initialHtml);
  const [bodyText, setBodyText] = useState(template?.body ?? "");
  const [category, setCategory] = useState(template?.category ?? "");
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) {
      show({ text: "Give the template a name", bad: true });
      return;
    }
    const isEdit = template !== null;
    setSaving(true);
    const res = await fetch(
      isEdit
        ? `/api/tools/master-inbox/reply-templates/${template.id}`
        : "/api/tools/master-inbox/reply-templates",
      {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          subject: subject.trim() || null,
          cc: cc.trim() || null,
          bcc: bcc.trim() || null,
          body: bodyText,
          body_html: bodyHtml || null,
          category: category.trim() || null,
        }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      show({ text: json.error ?? "Save failed", bad: true });
      return;
    }
    show({ text: isEdit ? `Saved “${name.trim()}”` : `Created “${name.trim()}”` });
    startTransition(() => onSaved());
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent style={{ maxWidth: "min(760px, calc(100vw - 2rem))" }}>
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
        </DialogHeader>
        <div className="mis-form mis-scroll">
          <div className="mis-g mis-g2">
            <Field label="Name">
              <input
                className="inp"
                aria-label="Template name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Schedule a call"
                autoFocus
              />
            </Field>
            <Field label="Category">
              <input
                className="inp"
                aria-label="Template category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Choose or type a category…"
                list="template-category-options"
              />
              <datalist id="template-category-options">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>

          <Field
            label="Subject"
            optional="(optional · only used on forward / new emails — replies keep the existing subject)"
          >
            <input
              className="inp"
              aria-label="Template subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Pre-fill the subject line"
            />
          </Field>

          <div className="mis-g mis-g2">
            <Field label="CC">
              <input
                className="inp"
                aria-label="Template CC"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="comma-separated emails"
              />
            </Field>
            <Field label="BCC">
              <input
                className="inp"
                aria-label="Template BCC"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                placeholder="comma-separated emails"
              />
            </Field>
          </div>

          <div className="mis-f">
            <span className="mis-l">Body</span>
            <TemplateRichEditor
              valueHtml={bodyHtml}
              onChange={({ html, text }) => {
                setBodyHtml(html);
                setBodyText(text);
              }}
              placeholder={
                "Write the reply text…\nUse the Insert variable menu for {{lead.first_name}}, {{lead.company}}, etc."
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  template,
  onClose,
  onDeleted,
}: {
  template: TemplateRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const show = useShowToast();
  const [pending, startTransition] = useTransition();
  async function confirmDelete() {
    const res = await fetch(`/api/tools/master-inbox/reply-templates/${template.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      show({ text: "Delete failed", bad: true });
      return;
    }
    show({ text: `Deleted “${template.name}”` });
    startTransition(() => onDeleted());
  }
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{template.name}&rdquo;?</DialogTitle>
        </DialogHeader>
        <p className="mis-sub" style={{ marginTop: 0 }}>
          This template will be removed for everyone in the workspace.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={confirmDelete}
            disabled={pending}
            data-mis="confirm-delete-template"
            style={{
              background: "var(--red)",
              borderColor: "var(--red)",
              color: "#fff",
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
